const Client = require("../models/Client");
const Admin = require("../models/Admin");
const HumanAgent = require("../models/HumanAgent");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getobject, putobject } = require("../utils/s3");
const KnowledgeBase = require("../models/KnowledgeBase");
const axios = require('axios');
const { OAuth2Client } = require("google-auth-library");
const Profile = require("../models/Profile");

// Initialize Google OAuth2 client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id, userType: 'client' }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};

// Authenticated: list approved profiles for current token's email
const listApprovedProfilesForCurrentUser = async (req, res) => {
  try {
    // Ensure we have an email; if missing (older admin token), fetch from DB
    let email = req.user?.email;
    if (!email) {
      if (req.user?.userType === 'admin') {
        const admin = await Admin.findById(req.user.id);
        email = admin?.email;
      } else if (req.user?.userType === 'client') {
        const client = await Client.findById(req.user.id);
        email = client?.email;
      } else if (req.user?.userType === 'humanAgent') {
        const ha = await HumanAgent.findById(req.user.id);
        email = ha?.email;
      }
    }
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email not available for current user' });
    }
    email = String(email).toLowerCase();

    const profiles = [];

    // Client
    const client = await Client.findOne({ email, isApproved: true });
    if (client) {
      profiles.push({
        role: 'client',
        id: client._id,
        clientUserId: client.userId,
        name: client.name,
        email: client.email,
        isApproved: !!client.isApproved,
        isprofileCompleted: !!client.isprofileCompleted
      });
    }

    // HumanAgents list policy
    // - For client tokens: list ALL approved human agents under this client (regardless of email)
    // - For non-client tokens: list approved human agents matching the same email (legacy behavior)
    if (req.user?.userType === 'client') {
      const clientScopedAgents = await HumanAgent.find({ clientId: req.user.id, isApproved: true }).populate('clientId');
      for (const ha of clientScopedAgents) {
        if (!ha.clientId) continue;
        profiles.push({
          role: 'humanAgent',
          id: ha._id,
          clientId: ha.clientId._id,
          clientUserId: ha.clientId.userId,
          clientName: ha.clientId.businessName || ha.clientId.name || ha.clientId.email,
          email: ha.email,
          isApproved: !!ha.isApproved,
          isprofileCompleted: !!ha.isprofileCompleted
        });
      }
    } else {
      const humanAgents = await HumanAgent.find({ email, isApproved: true }).populate('clientId');
      for (const ha of humanAgents) {
        if (!ha.clientId) continue;
        profiles.push({
          role: 'humanAgent',
          id: ha._id,
          clientId: ha.clientId._id,
          clientUserId: ha.clientId.userId,
          clientName: ha.clientId.businessName || ha.clientId.name || ha.clientId.email,
          email: ha.email,
          isApproved: !!ha.isApproved,
          isprofileCompleted: !!ha.isprofileCompleted
        });
      }
    }

    // Admin
    const admin = await Admin.findOne({ email });
    if (admin) {
      profiles.push({
        role: 'admin',
        id: admin._id,
        name: admin.name,
        email: admin.email
      });
    }

    // If no profiles exist for this email, auto-onboard as a minimal client and return a client JWT
    if (profiles.length === 0) {
      // Create minimal client if not exists (unapproved, incomplete profile)
      let existing = await Client.findOne({ email });
      if (!existing) {
        try {
          const inferredName = String(email).split('@')[0];
          existing = await Client.create({
            name: inferredName,
            email,
            password: '',
            isGoogleUser: false,
            isprofileCompleted: false,
            isApproved: false
          });
          // Best-effort: seed welcome credits
          try {
            const Credit = require("../models/Credit");
            const creditRecord = await Credit.getOrCreateCreditRecord(existing._id);
            if ((creditRecord?.currentBalance || 0) === 0) {
              await creditRecord.addCredits(100, 'bonus', 'Welcome bonus credits');
            }
          } catch (_) {}
        } catch (e) {
          console.error('Auto-onboard client failed:', e);
          return res.status(500).json({ success: false, message: 'Failed to auto-create profile' });
        }
      }

      const token = jwt.sign({ id: existing._id, email: existing.email, userType: 'client' }, process.env.JWT_SECRET, { expiresIn: '7d' });
      const profileId = await Profile.findOne({ clientId: existing._id });

      return res.json({
        success: true,
        autoOnboard: true,
        token,
        userType: 'client',
        id: existing._id,
        email: existing.email,
        name: existing.name,
        clientUserId: existing.userId,
        isApproved: !!existing.isApproved,
        isprofileCompleted: !!existing.isprofileCompleted,
        profileId: profileId ? profileId._id : null,
        profiles: []
      });
    }

    return res.json({ success: true, profiles });
  } catch (error) {
    console.error('listApprovedProfilesForCurrentUser error:', error);
    return res.status(500).json({ success: false, message: 'Failed to list profiles' });
  }
};

// Authenticated: switch to selected profile and issue JWT
const switchProfile = async (req, res) => {
  try {
    // Enforce: humanAgent tokens issued by client cannot switch
    try {
      const authHeader = req.headers.authorization || '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
      if (bearer) {
        const decodedSwitch = jwt.verify(bearer, process.env.JWT_SECRET);
        if (decodedSwitch && decodedSwitch.userType === 'humanAgent') {
          if (decodedSwitch.aud === 'humanAgent' && decodedSwitch.allowSwitch !== true) {
            return res.status(403).json({ success: false, message: 'Switch not allowed for this agent token' });
          }
        }
      }
    } catch (_) {}
    // Resolve email like above
    let email = req.user?.email;
    if (!email) {
      if (req.user?.userType === 'admin') {
        const admin = await Admin.findById(req.user.id);
        email = admin?.email;
      } else if (req.user?.userType === 'client') {
        const client = await Client.findById(req.user.id);
        email = client?.email;
      } else if (req.user?.userType === 'humanAgent') {
        const ha = await HumanAgent.findById(req.user.id);
        email = ha?.email;
      }
    }
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email not available for current user' });
    }
    email = String(email).toLowerCase();

    // Accept full profile object or { role, id } or raw model objects
    let role = req.body?.role;
    let id = req.body?.id || req.body?._id;

    // If role missing, infer from body shape
    if (!role) {
      const b = req.body || {};
      // HumanAgent-like shapes
      if (b.humanAgentName || b.agentIds || b.role === 'humanAgent' || b.clientId) {
        role = 'humanAgent';
        id = id || b.humanAgentId || b.id || b._id;
      }
      // Client-like shapes
      else if (b.clientUserId || b.businessName || b.clientType || b.gstNo || b.panNo) {
        role = 'client';
        id = id || b.clientId || b.id || b._id;
      }
      // Admin-like
      else if (b.userType === 'admin') {
        role = 'admin';
        id = id || b.id || b._id;
      }
    }

    if (!role || !id) {
      return res.status(400).json({ success: false, message: 'role and id (or a profile object) are required' });
    }

    if (role === 'client') {
      const client = await Client.findOne({ _id: id, email });
      if (!client) return res.status(404).json({ success: false, message: 'Client not found for this email' });
      if (!client.isApproved) return res.status(401).json({ success: false, message: 'Client not approved' });

      const sameEmailAdmin = await Admin.findOne({ email });
      const adminAccess = !!sameEmailAdmin;
      const adminId = sameEmailAdmin ? String(sameEmailAdmin._id) : undefined;

      const token = jwt.sign({ id: client._id, email: client.email, userType: 'client', adminAccess, adminId }, process.env.JWT_SECRET, { expiresIn: '7d' });
      const profileId = await Profile.findOne({ clientId: client._id });

      return res.json({ success: true, token, userType: 'client', id: client._id, email: client.email, name: client.name, clientUserId: client.userId, adminAccess, adminId, isApproved: !!client.isApproved, isprofileCompleted: !!client.isprofileCompleted, profileId: profileId ? profileId._id : null });
    }

    if (role === 'humanAgent') {
      // If caller is client: validate by clientId context
      if (req.user?.userType === 'client') {
        const clientIdCtx = req.user.id;
        const humanAgent = await HumanAgent.findOne({ _id: id, clientId: clientIdCtx }).populate('clientId');
        if (!humanAgent) return res.status(404).json({ success: false, message: 'Human agent not found under this client' });
        if (!humanAgent.isApproved) return res.status(401).json({ success: false, message: 'Human agent not approved' });
        if (!humanAgent.clientId) return res.status(400).json({ success: false, message: 'Associated client not found' });

        const jwtToken = jwt.sign({ id: humanAgent._id, userType: 'humanAgent', clientId: humanAgent.clientId._id, email: humanAgent.email, aud: 'humanAgent', allowSwitch: false, impersonatedBy: { type: 'client', id: String(clientIdCtx) } }, process.env.JWT_SECRET, { expiresIn: '1h' });``
        const humanAgentProfileId = await Profile.findOne({ humanAgentId: humanAgent._id });
        const clientProfileId = await Profile.findOne({ clientId: humanAgent.clientId._id });

        return res.json({ success: true, token: jwtToken, userType: 'humanAgent', id: humanAgent._id, email: humanAgent.email, name: humanAgent.humanAgentName, isApproved: !!humanAgent.isApproved, isprofileCompleted: !!humanAgent.isprofileCompleted, clientId: humanAgent.clientId._id, clientUserId: humanAgent.clientId.userId, clientName: humanAgent.clientId.businessName || humanAgent.clientId.name || humanAgent.clientId.email, humanAgentProfileId: humanAgentProfileId ? humanAgentProfileId._id : null, clientProfileId: clientProfileId ? clientProfileId._id : null });
      }

      // If caller is self humanAgent: validate by email across associations
      if (req.user?.userType === 'humanAgent') {
        const currentAgent = await HumanAgent.findById(req.user.id);
        if (!currentAgent) return res.status(401).json({ success: false, message: 'Current agent not found' });
        const humanAgent = await HumanAgent.findOne({ _id: id, email: currentAgent.email }).populate('clientId');
        if (!humanAgent) return res.status(404).json({ success: false, message: 'Human agent not found for this email' });
        if (!humanAgent.isApproved) return res.status(401).json({ success: false, message: 'Human agent not approved' });
        if (!humanAgent.clientId) return res.status(400).json({ success: false, message: 'Associated client not found' });

        const jwtToken = jwt.sign({ id: humanAgent._id, userType: 'humanAgent', clientId: humanAgent.clientId._id, email: humanAgent.email, aud: 'humanAgent', allowSwitch: true }, process.env.JWT_SECRET, { expiresIn: '7d' });
        const humanAgentProfileId = await Profile.findOne({ humanAgentId: humanAgent._id });
        const clientProfileId = await Profile.findOne({ clientId: humanAgent.clientId._id });

        return res.json({ success: true, token: jwtToken, userType: 'humanAgent', id: humanAgent._id, email: humanAgent.email, name: humanAgent.humanAgentName, isApproved: !!humanAgent.isApproved, isprofileCompleted: !!humanAgent.isprofileCompleted, clientId: humanAgent.clientId._id, clientUserId: humanAgent.clientId.userId, clientName: humanAgent.clientId.businessName || humanAgent.clientId.name || humanAgent.clientId.email, humanAgentProfileId: humanAgentProfileId ? humanAgentProfileId._id : null, clientProfileId: clientProfileId ? clientProfileId._id : null });
      }

      return res.status(403).json({ success: false, message: 'Unsupported token for human agent switch' });
    }

    if (role === 'admin') {
      const admin = await Admin.findOne({ _id: id, email });
      if (!admin) return res.status(404).json({ success: false, message: 'Admin not found for this email' });
      const token = jwt.sign({ id: admin._id, userType: 'admin', email: admin.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.json({ success: true, token, userType: 'admin', id: admin._id, email: admin.email, name: admin.name });
    }

    return res.status(400).json({ success: false, message: 'Invalid role' });
  } catch (error) {
    console.error('switchProfile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to switch profile' });
  }
};

// Step 2A: List approved profiles for a Google email (client + humanAgent + admin)
const googleListApprovedProfiles = async (req, res) => {
  try {
    if (!req.googleUser || !req.googleUser.email) {
      return res.status(400).json({ success: false, message: 'Missing Google user' });
    }

    const email = String(req.googleUser.email).toLowerCase();

    const profiles = [];

    // Approved client profile (same email)
    const client = await Client.findOne({ email, isApproved: true });
    if (client) {
      profiles.push({
        role: 'client',
        id: client._id,
        clientUserId: client.userId,
        name: client.name,
        email: client.email,
        isApproved: !!client.isApproved,
        isprofileCompleted: !!client.isprofileCompleted
      });
    }

    // Approved humanAgent profiles (same email) across clients
    const humanAgents = await HumanAgent.find({ email, isApproved: true }).populate('clientId');
    for (const ha of humanAgents) {
      if (!ha.clientId) continue;
      profiles.push({
        role: 'humanAgent',
        id: ha._id,
        clientId: ha.clientId._id,
        clientUserId: ha.clientId.userId,
        clientName: ha.clientId.businessName || ha.clientId.name || ha.clientId.email,
        email: ha.email,
        isApproved: !!ha.isApproved,
        isprofileCompleted: !!ha.isprofileCompleted
      });
    }

    // Admin profile (same email) - no approval flag on Admin model
    const admin = await Admin.findOne({ email });
    if (admin) {
      profiles.push({
        role: 'admin',
        id: admin._id,
        name: admin.name,
        email: admin.email
      });
    }

    // If nothing exists for this Google email, auto-onboard as minimal client
    if (profiles.length === 0) {
      let client = await Client.findOne({ email });
      if (!client) {
        try {
          client = await Client.create({
            name: req.googleUser.name || email.split('@')[0],
            email,
            password: '',
            isGoogleUser: true,
            googleId: req.googleUser.googleId,
            googlePicture: req.googleUser.picture,
            emailVerified: !!req.googleUser.emailVerified,
            isprofileCompleted: false,
            isApproved: false
          });
          // Seed default credits (best-effort)
          try {
            const Credit = require('../models/Credit');
            const creditRecord = await Credit.getOrCreateCreditRecord(client._id);
            if ((creditRecord?.currentBalance || 0) === 0) {
              await creditRecord.addCredits(100, 'bonus', 'Welcome bonus credits');
            }
          } catch (_) {}
        } catch (e) {
          console.error('google/profiles auto-onboard failed:', e);
          return res.status(500).json({ success: false, message: 'Failed to auto-create profile' });
        }
      }

      const token = jwt.sign({ id: client._id, email: client.email, userType: 'client' }, process.env.JWT_SECRET, { expiresIn: '7d' });
      const profileId = await Profile.findOne({ clientId: client._id });

      return res.json({
        success: true,
        autoOnboard: true,
        token,
        userType: 'client',
        id: client._id,
        email: client.email,
        name: client.name,
        clientUserId: client.userId,
        isApproved: !!client.isApproved,
        isprofileCompleted: !!client.isprofileCompleted,
        profileId: profileId ? profileId._id : null,
        profiles: []
      });
    }

    // If exactly one profile exists, directly issue a token for that role to skip selection
    if (profiles.length === 1) {
      const only = profiles[0];
      if (only.role === 'client') {
        const client = await Client.findOne({ _id: only.id, email });
        if (client) {
          const sameEmailAdmin = await Admin.findOne({ email });
          const adminAccess = !!sameEmailAdmin;
          const adminId = sameEmailAdmin ? String(sameEmailAdmin._id) : undefined;
          const token = jwt.sign({ id: client._id, email: client.email, userType: 'client', adminAccess, adminId }, process.env.JWT_SECRET, { expiresIn: '7d' });
          const profileId = await Profile.findOne({ clientId: client._id });
          return res.json({ success: true, singleProfile: true, token, userType: 'client', id: client._id, email: client.email, name: client.name, clientUserId: client.userId, adminAccess, adminId, isApproved: !!client.isApproved, isprofileCompleted: !!client.isprofileCompleted, profileId: profileId ? profileId._id : null });
        }
      } else if (only.role === 'humanAgent') {
        const humanAgent = await HumanAgent.findOne({ _id: only.id, email }).populate('clientId');
        if (humanAgent && humanAgent.clientId && humanAgent.isApproved) {
          const jwtToken = jwt.sign({ id: humanAgent._id, userType: 'humanAgent', clientId: humanAgent.clientId._id, email: humanAgent.email, aud: 'humanAgent', allowSwitch: true }, process.env.JWT_SECRET, { expiresIn: '7d' });
          const humanAgentProfileId = await Profile.findOne({ humanAgentId: humanAgent._id });
          const clientProfileId = await Profile.findOne({ clientId: humanAgent.clientId._id });
          return res.json({ success: true, singleProfile: true, token: jwtToken, userType: 'humanAgent', id: humanAgent._id, email: humanAgent.email, name: humanAgent.humanAgentName, isApproved: !!humanAgent.isApproved, isprofileCompleted: !!humanAgent.isprofileCompleted, clientId: humanAgent.clientId._id, clientUserId: humanAgent.clientId.userId, clientName: humanAgent.clientId.businessName || humanAgent.clientId.name || humanAgent.clientId.email, humanAgentProfileId: humanAgentProfileId ? humanAgentProfileId._id : null, clientProfileId: clientProfileId ? clientProfileId._id : null });
        }
      } else if (only.role === 'admin') {
        const admin = await Admin.findOne({ _id: only.id, email });
        if (admin) {
          const token = jwt.sign({ id: admin._id, userType: 'admin', email: admin.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
          return res.json({ success: true, singleProfile: true, token, userType: 'admin', id: admin._id, email: admin.email, name: admin.name });
        }
      }
      // Fallback to listing if validation failed
    }

    return res.json({ success: true, profiles });
  } catch (error) {
    console.error('googleListApprovedProfiles error:', error);
    return res.status(500).json({ success: false, message: 'Failed to list profiles' });
  }
};

// Step 2B: Select a profile and issue a role-specific JWT
const googleSelectProfile = async (req, res) => {
  try {
    if (!req.googleUser || !req.googleUser.email) {
      return res.status(400).json({ success: false, message: 'Missing Google user' });
    }
    const email = String(req.googleUser.email).toLowerCase();

    // Accept either { role, id } OR full profile object previously returned
    let role = req.body?.role;
    let id = req.body?.id;
    const bodyHasProfileShape = req.body && typeof req.body === 'object' && (req.body.role && req.body.id && req.body.email);
    if (bodyHasProfileShape) {
      role = req.body.role;
      id = req.body.id;
      // For humanAgent, clientId may be present in body; we will validate against DB
    }
    if (!role || !id) {
      return res.status(400).json({ success: false, message: 'role and id are required' });
    }

    if (role === 'client') {
      const client = await Client.findOne({ _id: id, email });
      if (!client) {
        return res.status(404).json({ success: false, message: 'Client not found for this email' });
      }
      if (!client.isApproved) {
        return res.status(401).json({ success: false, message: 'Client not approved' });
      }

      // If same email is an admin, expose adminAccess and adminId in token like existing tokens
      const sameEmailAdmin = await Admin.findOne({ email });
      const adminAccess = !!sameEmailAdmin;
      const adminId = sameEmailAdmin ? String(sameEmailAdmin._id) : undefined;

      const token = jwt.sign({ 
        id: client._id, 
        email: client.email,
        userType: 'client',
        adminAccess: adminAccess,
        adminId: adminId
      }, process.env.JWT_SECRET, { expiresIn: '7d' });
      const profileId = await Profile.findOne({ clientId: client._id });

      return res.json({
        success: true,
        token,
        userType: 'client',
        id: client._id,
        email: client.email,
        name: client.name,
        clientUserId: client.userId,
        adminAccess: adminAccess,
        adminId: adminId,
        isApproved: !!client.isApproved,
        isprofileCompleted: !!client.isprofileCompleted,
        profileId: profileId ? profileId._id : null
      });
    }

    if (role === 'humanAgent') {
      const humanAgent = await HumanAgent.findOne({ _id: id, email }).populate('clientId');
      if (!humanAgent) {
        return res.status(404).json({ success: false, message: 'Human agent not found for this email' });
      }
      if (!humanAgent.isApproved) {
        return res.status(401).json({ success: false, message: 'Human agent not approved' });
      }
      if (!humanAgent.clientId) {
        return res.status(400).json({ success: false, message: 'Associated client not found' });
      }

      // This is a “self-selected” agent token from Google selection: allow further switches (agent-only)
      const jwtToken = jwt.sign({ id: humanAgent._id, userType: 'humanAgent', clientId: humanAgent.clientId._id, email: humanAgent.email, aud: 'humanAgent', allowSwitch: true }, process.env.JWT_SECRET, { expiresIn: '7d' });
      const humanAgentProfileId = await Profile.findOne({ humanAgentId: humanAgent._id });
      const clientProfileId = await Profile.findOne({ clientId: humanAgent.clientId._id });

      return res.json({
        success: true,
        token: jwtToken,
        userType: 'humanAgent',
        id: humanAgent._id,
        email: humanAgent.email,
        name: humanAgent.humanAgentName,
        isApproved: !!humanAgent.isApproved,
        isprofileCompleted: !!humanAgent.isprofileCompleted,
        clientId: humanAgent.clientId._id,
        clientUserId: humanAgent.clientId.userId,
        clientName: humanAgent.clientId.businessName || humanAgent.clientId.name || humanAgent.clientId.email,
        humanAgentProfileId: humanAgentProfileId ? humanAgentProfileId._id : null,
        clientProfileId: clientProfileId ? clientProfileId._id : null
      });
    }

    if (role === 'admin') {
      const admin = await Admin.findOne({ _id: id, email });
      if (!admin) {
        return res.status(404).json({ success: false, message: 'Admin not found for this email' });
      }

      // Include email in admin token
      const token = jwt.sign({ id: admin._id, userType: 'admin', email: admin.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.json({
        success: true,
        token,
        userType: 'admin',
        id: admin._id,
        email: admin.email,
        name: admin.name
      });
    }

    return res.status(400).json({ success: false, message: 'Invalid role' });
  } catch (error) {
    console.error('googleSelectProfile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to select profile' });
  }
};

const getUploadUrl = async (req, res) => {
  try {
    const { fileName, fileType } = req.query;
    if (!fileName || !fileType) {
      return res.status(400).json({ success: false, message: 'fileName and fileType are required' });
    }
    const key = `businessLogo/${Date.now()}_${fileName}`;
    const url = await putobject(key, fileType);
    res.json({ success: true, url, key });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getUploadUrlMyBusiness = async (req, res) => {
  try {
    const { fileName, fileType } = req.query;
    if (!fileName || !fileType) {
      return res.status(400).json({ success: false, message: 'fileName and fileType are required' });
    }
    const key = `mybusiness/${Date.now()}_${fileName}`;
    const url = await putobject(key, fileType);
    res.json({ success: true, url, key });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getUploadUrlCustomization = async (req, res) => {
  try {
    const { fileName, fileType } = req.query;
    if (!fileName || !fileType) {
      return res.status(400).json({ success: false, message: 'fileName and fileType are required' });
    }
    const key = `agentCustomization/${Date.now()}_${fileName}`;
    const url = await putobject(key, fileType);
    res.json({ success: true, url, key });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Knowledge Base: Generate presigned URL for uploading agent KB files
const getUploadUrlKnowledgeBase = async (req, res) => {
  try {
    const { fileName, fileType } = req.query;
    if (!fileName || !fileType) {
      return res.status(400).json({ success: false, message: 'fileName and fileType are required' });
    }
    const key = `agentKnowledgeBase/${Date.now()}_${fileName}`;
    const url = await putobject(key, fileType);
    res.json({ success: true, url, key });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Generic: Generate presigned GET URL for a given S3 key
const getFileUrlByKey = async (req, res) => {
  try {
    const { key } = req.query;
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success: false, message: 'key is required' });
    }
    const url = await getobject(key);
    // Redirect to the signed URL so browsers can open/download directly
    return res.redirect(url);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// Knowledge Base CRUD operations

// Create knowledge base item
const createKnowledgeItem = async (req, res) => {
  try {
    const { agentId, type, title, description, content, tags } = req.body;
    const clientId = req.user.id;

    if (!agentId || !type || !title) {
      return res.status(400).json({ 
        success: false, 
        message: 'agentId, type, and title are required' 
      });
    }

    // Validate content based on type
    let validatedContent = {};
    switch (type) {
      case 'pdf':
        if (!content.s3Key) {
          return res.status(400).json({ 
            success: false, 
            message: 'S3 key is required for PDF files' 
          });
        }
        validatedContent = { s3Key: content.s3Key };
        break;
        
      case 'text':
        // Enforce S3 storage for text as .txt
        if (!content.s3Key) {
          return res.status(400).json({ 
            success: false, 
            message: 'S3 key is required for text files' 
          });
        }
        validatedContent = { s3Key: content.s3Key };
        break;
        
      case 'image':
        if (!content.imageKey) {
          return res.status(400).json({ 
            success: false, 
            message: 'S3 key is required for images' 
          });
        }
        validatedContent = { imageKey: content.imageKey };
        break;
        
      case 'youtube':
        if (!content.youtubeId && !content.youtubeUrl) {
          return res.status(400).json({ 
            success: false, 
            message: 'YouTube ID or URL is required' 
          });
        }
        validatedContent = { 
          youtubeId: content.youtubeId,
          youtubeUrl: content.youtubeUrl 
        };
        break;
        
      case 'link':
        if (!content.url) {
          return res.status(400).json({ 
            success: false, 
            message: 'URL is required for links' 
          });
        }
        validatedContent = { 
          url: content.url,
          linkText: content.linkText || content.url
        };
        break;
        
      case 'website':
        if (!content.url) {
          return res.status(400).json({ 
            success: false, 
            message: 'URL is required for websites' 
          });
        }
        validatedContent = { 
          url: content.url
        };
        break;
        
      default:
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid content type' 
        });
    }

    const knowledgeItem = new KnowledgeBase({
      agentId,
      clientId,
      type,
      title,
      description,
      content: validatedContent,
      tags: tags || [],
      fileMetadata: content.fileMetadata || {}
    });

    await knowledgeItem.save();

    res.status(201).json({
      success: true,
      data: knowledgeItem,
      message: 'Knowledge item created successfully'
    });

  } catch (error) {
    console.error('Error creating knowledge item:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// Embed (process) a knowledge base document via external RAG API
const embedKnowledgeItem = async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = req.user.id;

    const item = await KnowledgeBase.findOne({ _id: id, clientId, isActive: true });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Knowledge item not found' });
    }

    // Only PDF and image types currently rely on S3; links/websites/youtube could also be supported if URL exists
    let url = null;
    if (item.type === 'pdf' || item.type === 'image') {
      if (!item.content?.s3Key) {
        return res.status(400).json({ success: false, message: 'Missing S3 key for this item' });
      }
      // Generate a temporary GET URL
      try {
        url = await getobject(item.content.s3Key);
      } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to generate file URL' });
      }
    } else if (item.type === 'text' || item.type === 'link' || item.type === 'website' || item.type === 'youtube') {
      if (item.type === 'text') {
        if (!item.content?.s3Key) {
          return res.status(400).json({ success: false, message: 'Missing S3 key for this text item' });
        }
        try {
          url = await getobject(item.content.s3Key);
        } catch (e) {
          return res.status(500).json({ success: false, message: 'Failed to generate file URL' });
        }
      } else {
        url = item.content?.url || item.content?.youtubeUrl || null;
      }
      if (!url) {
        return res.status(400).json({ success: false, message: 'No URL available to embed for this item' });
      }
    } else {
      return res.status(400).json({ success: false, message: 'Embedding supported only for pdf/image/link/website/youtube' });
    }

    const payload = {
      url,
      book_name: String(item.agentId),
      chapter_name: String(item._id),
      client_id: String(clientId)
    };

    const ragUrl = 'https://vectrize.ailisher.com/api/v1/rag/process-document';
    const resp = await axios.post(ragUrl, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });

    // Mark item as embedded with metadata
    item.isEmbedded = true;
    item.embeddedAt = new Date();
    const meta = resp?.data?.data || {};
    item.embedMeta = {
      message: meta.message,
      processedChunks: meta.processed_chunks,
      totalBatches: meta.total_batches,
      totalLatency: meta.total_latency,
      chunkingLatency: meta.chunking_latency,
      embeddingLatency: meta.embedding_latency
    };
    await item.save();

    res.json({ success: true, data: resp.data, message: 'Embedding completed' });
  } catch (error) {
    console.error('Error embedding knowledge item:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to embed knowledge item' });
  }
};

// Get knowledge base items for an agent
const getKnowledgeItems = async (req, res) => {
  try {
    const { agentId } = req.params;
    const { type } = req.query;
    const clientId = req.user.id;

    let query = { agentId, clientId, isActive: true };
    if (type) {
      query.type = type;
    }

    const knowledgeItems = await KnowledgeBase.find(query)
      .sort({ createdAt: -1 })
      .lean();

    // Generate URLs for items that need them
    const itemsWithUrls = await Promise.all(
      knowledgeItems.map(async (item) => {
        const itemObj = item.toObject ? item.toObject() : item;
        try {
          itemObj.contentUrl = await getContentUrl(itemObj);
        } catch (error) {
          console.error('Error generating URL for item:', item._id, error);
          itemObj.contentUrl = null;
        }
        return itemObj;
      })
    );

    res.json({
      success: true,
      data: itemsWithUrls
    });

  } catch (error) {
    console.error('Error fetching knowledge items:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// Update knowledge base item
const updateKnowledgeItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, content, tags } = req.body;
    const clientId = req.user.id;

    const knowledgeItem = await KnowledgeBase.findOne({ 
      _id: id, 
      clientId, 
      isActive: true 
    });

    if (!knowledgeItem) {
      return res.status(404).json({ 
        success: false, 
        message: 'Knowledge item not found' 
      });
    }

    // Update fields
    if (title) knowledgeItem.title = title;
    if (description !== undefined) knowledgeItem.description = description;
    if (content) {
      // Validate content based on type
      let validatedContent = {};
      switch (knowledgeItem.type) {
        case 'pdf':
          if (content.s3Key) validatedContent = { s3Key: content.s3Key };
          break;
        case 'text':
          if (content.s3Key) validatedContent = { s3Key: content.s3Key };
          break;
        case 'image':
          if (content.imageKey) validatedContent = { imageKey: content.imageKey };
          break;
        case 'youtube':
          validatedContent = { 
            youtubeId: content.youtubeId || knowledgeItem.content.youtubeId,
            youtubeUrl: content.youtubeUrl || knowledgeItem.content.youtubeUrl
          };
          break;
        case 'link':
          validatedContent = { 
            url: content.url || knowledgeItem.content.url,
            linkText: content.linkText || knowledgeItem.content.linkText
          };
          break;
      }
      if (Object.keys(validatedContent).length > 0) {
        knowledgeItem.content = { ...knowledgeItem.content, ...validatedContent };
      }
    }
    if (tags) knowledgeItem.tags = tags;

    await knowledgeItem.save();

    res.json({
      success: true,
      data: knowledgeItem,
      message: 'Knowledge item updated successfully'
    });

  } catch (error) {
    console.error('Error updating knowledge item:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// Delete knowledge base item
const deleteKnowledgeItem = async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = req.user.id;

    const knowledgeItem = await KnowledgeBase.findOne({ 
      _id: id, 
      clientId, 
      isActive: true 
    });

    if (!knowledgeItem) {
      return res.status(404).json({ 
        success: false, 
        message: 'Knowledge item not found' 
      });
    }

    // Soft delete
    knowledgeItem.isActive = false;
    await knowledgeItem.save();

    res.json({
      success: true,
      message: 'Knowledge item deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting knowledge item:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// Issue a human agent token for a given agent under the current client context
const getHumanAgentToken = async (req, res) => {
  try {
    const { agentId } = req.params;

    // Resolve client context: prefer req.clientId (set by verifyClientOrAdminAndExtractClientId), fallback to token user
    const clientId = req.clientId || (req.user?.userType === 'client' ? req.user.id : undefined);
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'Client context is required' });
    }

    // Validate the human agent belongs to this client and is approved
    const humanAgent = await HumanAgent.findOne({ _id: agentId, clientId, isApproved: true });
    if (!humanAgent) {
      return res.status(404).json({ success: false, message: 'Human agent not found for this client or not approved' });
    }

    // Create human agent token mirroring existing structure
    const token = jwt.sign({ 
      id: humanAgent._id, 
      userType: 'humanAgent', 
      clientId: humanAgent.clientId, 
      email: humanAgent.email,
      aud: 'humanAgent',
      allowSwitch: false,
      impersonatedBy: { type: req.user?.userType || 'client', id: String(req.user?.id || clientId) }
    }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // Optionally include profiles
    const humanAgentProfileId = await Profile.findOne({ humanAgentId: humanAgent._id });

    return res.json({
      success: true,
      token,
      userType: 'humanAgent',
      id: humanAgent._id,
      email: humanAgent.email,
      name: humanAgent.humanAgentName,
      clientId: humanAgent.clientId,
      isApproved: !!humanAgent.isApproved,
      isprofileCompleted: !!humanAgent.isprofileCompleted,
      humanAgentProfileId: humanAgentProfileId ? humanAgentProfileId._id : null
    });
  } catch (error) {
    console.error('getHumanAgentToken error:', error);
    return res.status(500).json({ success: false, message: 'Failed to issue human agent token' });
  }
};

// Helper function to get content URL
const getContentUrl = async (item) => {
  switch (item.type) {
    case 'pdf':
    case 'image':
      if (item.content.s3Key) {
        try {
          return await getobject(item.content.s3Key);
        } catch (error) {
          console.error('Error generating S3 URL:', error);
          return null;
        }
      }
      return null;
      
    case 'youtube':
      return item.content.youtubeUrl || `https://www.youtube.com/watch?v=${item.content.youtubeId}`;
      
    case 'link':
      return item.content.url;
      
    default:
      return null;
  }
};

const getClientProfile = async (req, res) => {
  try {
    const clientId = req.user.id;
    const client = await Client.findById(clientId).select('-password');
    if (!client) {
      return res.status(404).json({
        success: false,
        message: "Client not found"
      });
    }
    let businessLogoUrl = '';
    if (client.businessLogoKey) {
      businessLogoUrl = await getobject(client.businessLogoKey);
    }
    res.status(200).json({
      success: true,
      data: {
        ...client.toObject(),
        businessLogoUrl
      }
    });
  } catch (error) {
    console.error('Error fetching client profile:', error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch client profile"
    });
  }
};

// Login client
const loginClient = async (req, res) => {
  try {
    const { email, password } = req.body;

    
    // Regular email/password login
    console.log('Regular login attempt for client with email:', email);

    if (!email || !password) {
      console.log('Missing credentials');
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    // Check if client exists
    const client = await Client.findOne({ email });
    if (!client) {
      console.log('Client not found for email:', email);
      return res.status(401).json({ 
        success: false, 
        message: "Invalid email or password" 
      });
    }

    console.log('Client found, verifying password');

    // Check if password matches
    const isPasswordValid = await bcrypt.compare(password, client.password);
    console.log(isPasswordValid);
    if (!isPasswordValid) {
      console.log('Invalid password for client email:', email);
      return res.status(401).json({ 
        success: false, 
        message: "Invalid email or password" 
      });
    }

    console.log('Password verified, generating token');

    // Generate token with userType
    const jwtToken = jwt.sign(
      { 
        id: client._id,
        userType: 'client'
      }, 
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    console.log('Login successful for client email:', email);

    // Get profile ID for client
    let profileId = await Profile.findOne({clientId: client._id});

    let code; 
    
    if (client.isprofileCompleted && client.isApproved) {
      code = 202;  
    } else if (client.isprofileCompleted && !client.isApproved) {
      code = 203; 
    }

    res.status(200).json({
      success: true,
      token: jwtToken,
      client: {
        _id: client._id,
        name: client.name,
        email: client.email,
        code: code,
        businessName: client.businessName,
        gstNo: client.gstNo,
        panNo: client.panNo,
        mobileNo: client.mobileNo,
        address: client.address,
        city: client.city,
        pincode: client.pincode,
        websiteUrl: client.websiteUrl,
        isApproved: client.isApproved || false,
        isprofileCompleted: client.isprofileCompleted || false,
        profileId: profileId ? profileId._id : null
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || "An error occurred during login"
    });
  }
};


const googleLogin = async (req, res) => {
  try {
    const loginType = req.body.loginType; // 'humanAgent' or undefined
    // googleUser is set by verifyGoogleToken middleware
    const { email, name, picture, emailVerified, googleId } = req.googleUser;
    const userEmail = email.toLowerCase();
    console.log('Google login attempt for email:', userEmail);

    if (loginType === 'humanAgent') {
      // Only check HumanAgent model
      const humanAgent = await HumanAgent.findOne({ email: userEmail }).populate('clientId');
      if (!humanAgent) {
        return res.status(404).json({
          success: false,
          message: "You are not registered as a human agent. Please contact your administrator."
        });
      }
      // Check if human agent is approved
      if (!humanAgent.isApproved) {
        console.log('Human agent not approved:', humanAgent._id);
        return res.status(401).json({ 
          success: false, 
          message: "Your human agent account is not yet approved. Please contact your administrator." 
        });
      }
      // Get client information
      const client = await Client.findById(humanAgent.clientId);
      if (!client) {
        console.log('Client not found for human agent:', humanAgent._id);
        return res.status(401).json({ 
          success: false, 
          message: "Associated client not found" 
        });
      }
      // Get profile information for human agent
      let humanAgentProfileId = await Profile.findOne({humanAgentId: humanAgent._id});
      // Generate token for human agent
      const jwtToken = jwt.sign(
        { 
          id: humanAgent._id, 
          userType: 'humanAgent',
          clientId: client._id,
          email: humanAgent.email
        }, 
        process.env.JWT_SECRET, 
        { expiresIn: "7d" }
      );
      // Return response in the exact format you specified
      return res.status(200).json({
        success: true,
        message: "Profile incomplete",
        token: jwtToken,
        userType: "executive",
        profileId: humanAgentProfileId ? humanAgentProfileId._id : null,
        isprofileCompleted: humanAgent.isprofileCompleted || false,
        id: humanAgent._id,
        email: humanAgent.email,
        name: humanAgent.humanAgentName,
        isApproved: humanAgent.isApproved || false
      });
    }

    // Step 1: Check if email exists as human agent FIRST (Priority)
    const humanAgent = await HumanAgent.findOne({ 
      email: userEmail 
    }).populate('clientId');

    if (humanAgent) {
      console.log('Human agent found:', humanAgent._id);
      // Check if human agent is approved
      if (!humanAgent.isApproved) {
        console.log('Human agent not approved:', humanAgent._id);
        return res.status(401).json({ 
          success: false, 
          message: "Your human agent account is not yet approved. Please contact your administrator." 
        });
      }
      // Get client information
      const client = await Client.findById(humanAgent.clientId);
      if (!client) {
        console.log('Client not found for human agent:', humanAgent._id);
        return res.status(401).json({ 
          success: false, 
          message: "Associated client not found" 
        });
      }
      console.log('Human agent Google login successful:', humanAgent._id);
      // Get profile information for human agent
      let humanAgentProfileId = await Profile.findOne({humanAgentId: humanAgent._id});
      // Generate token for human agent
      const jwtToken = jwt.sign(
        { 
          id: humanAgent._id, 
          userType: 'humanAgent',
          clientId: client._id,
          email: humanAgent.email
        }, 
        process.env.JWT_SECRET, 
        { expiresIn: "7d" }
      );
      // Return response in the exact format you specified
      return res.status(200).json({
        success: true,
        message: "Profile incomplete",
        token: jwtToken,
        userType: "executive",
        profileId: humanAgentProfileId ? humanAgentProfileId._id : null,
        isprofileCompleted: humanAgent.isprofileCompleted || false,
        id: humanAgent._id,
        email: humanAgent.email,
        name: humanAgent.humanAgentName,
        isApproved: humanAgent.isApproved || false
      });
    }

    // Step 2: If not human agent, check if email exists as client
    let client = await Client.findOne({ email: userEmail });
    if (client) {
      console.log('Client found:', client._id);
      // Existing client
      const token = generateToken(client._id);
      let profileId = await Profile.findOne({clientId: client._id});
      if (client.isprofileCompleted === true || client.isprofileCompleted === "true") {
        // Profile completed, proceed with login
        return res.status(200).json({
          success: true,
          message: "Profile incomplete",
          token,
          userType: "client",
          profileId: profileId ? profileId._id : null,
          isprofileCompleted: true,
          id: client._id,
          email: client.email,
          name: client.name,
          isApproved: client.isApproved || false
        });
      } else {
        // Profile not completed - return in exact format you specified
        return res.status(200).json({
          success: true,
          message: "Profile incomplete",
          token,
          userType: "client",
          profileId: profileId ? profileId._id : null,
          isprofileCompleted: false,
          id: client._id,
          email: client.email,
          name: client.name,
          isApproved: client.isApproved || false
        });
      }
    } else {
      // Step 3: New client, create with Google info
      console.log('Creating new client for email:', userEmail);
      const newClient = await Client.create({
        name,
        email,
        password: "", // No password for Google user
        isGoogleUser: true,
        googleId,
        googlePicture: picture,
        emailVerified,
        isprofileCompleted: false,
        isApproved: false
      });
      // Initialize default credits (100) for new client (Google sign-up)
      try {
        const Credit = require("../models/Credit");
        const creditRecord = await Credit.getOrCreateCreditRecord(newClient._id);
        if ((creditRecord?.currentBalance || 0) === 0) {
          await creditRecord.addCredits(100, 'bonus', 'Welcome bonus credits');
        }
      } catch (e) {
        console.error('Failed to initialize default credits for client (Google):', e.message);
      }
      const token = generateToken(newClient._id)
      return res.status(200).json({
        success: true,
        message: "Profile incomplete",
        token,
        userType: "client",
        isprofileCompleted: false,
        id: newClient._id,
        email: newClient.email,
        name: newClient.name,
        isApproved: newClient.isApproved || false
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Google login failed" });
  }
};

// Register new client
const registerClient = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      businessName,
      businessLogoKey,
      gstNo,
      panNo,
      mobileNo,
      address,
      city,
      pincode,
      websiteUrl
    } = req.body;

    // Check if client email already exists
    const existingClient = await Client.findOne({ email });
    if (existingClient) {
      return res.status(400).json({
        success: false,
        message: "Email already registered"
      });
    }

    // Check if client already exists with the same GST/PAN/MobileNo
    const existingBusinessClient = await Client.findOne({
      $or: [
        { gstNo },
        { panNo },
        { mobileNo }
      ]
    });

    if (existingBusinessClient) {
      return res.status(400).json({
        success: false,
        message: "Client already exists with the same GST, PAN, or Mobile number"
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    let businessLogoUrl = "";
    if(businessLogoKey) {
      businessLogoUrl = await getobject(businessLogoKey);
    }

    // Check if the token is from admin
    if (req.admin) {
      // Admin is creating the client - auto approve
      const client = await Client.create({
        name,
        email,
        password: hashedPassword,
        businessName,
        businessLogoKey,
        businessLogoUrl,
        gstNo,
        panNo,
        mobileNo,
        address,
        city,
        pincode,
        websiteUrl,
        isprofileCompleted: true,
        isApproved: true
      });

      // Initialize default credits (100) for new client
      try {
        const Credit = require("../models/Credit");
        const creditRecord = await Credit.getOrCreateCreditRecord(client._id);
        if ((creditRecord?.currentBalance || 0) === 0) {
          await creditRecord.addCredits(100, 'bonus', 'Welcome bonus credits');
        }
      } catch (e) {
        console.error('Failed to initialize default credits for client:', e.message);
      }

      // Telegram alert: client created by admin
      try {
        const { sendTelegramAlert } = require('../utils/telegramAlert');
        const when = new Date().toLocaleString('en-IN', { hour12: false });
        await sendTelegramAlert(`Client "${client.name || client.businessName || client.email}" is joined on ${when}.`);
      } catch (_) {}

      // Generate token
      const token = generateToken(client._id);

      res.status(201).json({
        success: true,
        token,
        client: {
          _id: client._id,
          name: client.name,
          email: client.email,
          businessName: client.businessName,
          businesslogoKey: client.businessLogoKey,
          businessLogoUrl: client.businessLogoUrl,
          gstNo: client.gstNo,
          panNo: client.panNo,
          mobileNo: client.mobileNo,
          address: client.address,
          city: client.city,
          pincode: client.pincode,
          websiteUrl: client.websiteUrl,
          isprofileCompleted: true,
          isApproved: true
        }
      });
    } else {
      // Non-admin registration - requires approval
      const client = await Client.create({
        name,
        email,
        password: hashedPassword,
        businessName,
        businessLogoKey,
        businessLogoUrl,
        gstNo,
        panNo,
        mobileNo,
        address,
        city,
        pincode,
        websiteUrl,
        isprofileCompleted: true,
        isApproved: false
      });

      // Initialize default credits (100) for new client
      try {
        const Credit = require("../models/Credit");
        const creditRecord = await Credit.getOrCreateCreditRecord(client._id);
        if ((creditRecord?.currentBalance || 0) === 0) {
          await creditRecord.addCredits(100, 'bonus', 'Welcome bonus credits');
        }
      } catch (e) {
        console.error('Failed to initialize default credits for client:', e.message);
      }

      // Telegram alert: client self-registered
      try {
        const { sendTelegramAlert } = require('../utils/telegramAlert');
        const when = new Date().toLocaleString('en-IN', { hour12: false });
        await sendTelegramAlert(`Client "${client.name || client.businessName || client.email}" is joined on ${when}.`);
      } catch (_) {}

      // Generate token
      const token = generateToken(client._id);

      res.status(201).json({
        success: true,
        token,
        client: {
          _id: client._id,
          name: client.name,
          email: client.email,
          businessName: client.businessName,
          businesslogoKey: client.businessLogoKey,
          businessLogoUrl: client.businessLogoUrl,
          gstNo: client.gstNo,
          panNo: client.panNo,
          mobileNo: client.mobileNo,
          address: client.address,
          city: client.city,
          pincode: client.pincode,
          websiteUrl: client.websiteUrl,
          isprofileCompleted: true,
          isApproved: false
        }
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ==================== HUMAN AGENT FUNCTIONS ====================

// Get all human agents for a client
const getHumanAgents = async (req, res) => {
  try {
    // Extract clientId from token
    const clientId = req.clientId;
    
    // Verify client exists
    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ 
        success: false, 
        message: "Client not found" 
      });
    }

    const humanAgents = await HumanAgent.find({ clientId })
      .populate('agentIds', 'agentName description role')
      .sort({ createdAt: -1 });

    // Rename role -> type in response shape
    const data = humanAgents.map((doc) => {
      const obj = doc.toObject ? doc.toObject() : { ...doc };
      obj.type = obj.role;
      delete obj.role;
      return obj;
    });

    res.json({ 
      success: true, 
      data 
    });
  } catch (error) {
    console.error("Error fetching human agents:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch human agents" 
    });
  }
};

// Create new human agent
const createHumanAgent = async (req, res) => {
  try {
    // Extract clientId from token
    const clientId = req.clientId;
    const { humanAgentName, email, mobileNumber, agentIds, role } = req.body;

    // Validate required fields
    if (!humanAgentName || !email || !mobileNumber || !agentIds || agentIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Human agent name, email, mobile number, and at least one agent are required" 
      });
    }

    console.log(clientId);

    // Verify client exists
    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ 
        success: false, 
        message: "Client not found" 
      });
    }

    // Check if human agent with same name already exists for this client
    const existingAgent = await HumanAgent.findOne({ 
      clientId, 
      humanAgentName: humanAgentName.trim() 
    });
    
    if (existingAgent) {
      return res.status(400).json({ 
        success: false, 
        message: "Human agent with this name already exists for this client" 
      });
    }

    // Check if email already exists for THIS client (allow same email across different clients)
    const normalizedEmail = email.toLowerCase().trim();
    const existingEmailForClient = await HumanAgent.findOne({ email: normalizedEmail, clientId });
    if (existingEmailForClient) {
      return res.status(400).json({ 
        success: false, 
        message: "Email already registered for this client" 
      });
    }

    const humanAgent = new HumanAgent({
      clientId,
      humanAgentName: humanAgentName.trim(),
      email: normalizedEmail,
      mobileNumber: mobileNumber.trim(),
      role: role || 'executive',
      isprofileCompleted: true,
      isApproved: true,
      agentIds: agentIds // Store all selected agent IDs
    });

    await humanAgent.save();

    res.status(201).json({ 
      success: true, 
      data: humanAgent,
      message: "Human agent created successfully" 
    });
  } catch (error) {
    console.error("Error creating human agent:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to create human agent" 
    });
  }
};

// Update human agent
const updateHumanAgent = async (req, res) => {
  try {
    // Extract clientId from token
    const clientId = req.clientId;
    const { agentId } = req.params;
    const { humanAgentName, email, mobileNumber, agentIds, role} = req.body;

    // Verify client exists
    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ 
        success: false, 
        message: "Client not found" 
      });
    }

    // If updating email, ensure uniqueness within this client
    let updateDoc = {
      humanAgentName: humanAgentName?.trim(),
      mobileNumber: mobileNumber?.trim(),
      role: role || 'executive',
      agentIds: agentIds || [],
      updatedAt: new Date()
    };

    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      const duplicate = await HumanAgent.findOne({ _id: { $ne: agentId }, clientId, email: normalizedEmail });
      if (duplicate) {
        return res.status(400).json({ success: false, message: 'Email already registered for this client' });
      }
      updateDoc.email = normalizedEmail;
    }

    // Find and update human agent
    const humanAgent = await HumanAgent.findOneAndUpdate(
      { _id: agentId, clientId },
      updateDoc,
      { new: true, runValidators: true }
    );

    if (!humanAgent) {
      return res.status(404).json({ 
        success: false, 
        message: "Human agent not found" 
      });
    }

    res.json({ 
      success: true, 
      data: humanAgent,
      message: "Human agent updated successfully" 
    });
  } catch (error) {
    console.error("Error updating human agent:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to update human agent" 
    });
  }
};

// Delete human agent
const deleteHumanAgent = async (req, res) => {
  try {
    // Extract clientId from token
    const clientId = req.clientId;
    const { agentId } = req.params;

    console.log('Delete request - clientId:', clientId, 'agentId:', agentId);

    // Verify client exists
    const client = await Client.findById(clientId);
    if (!client) {
      console.log('Client not found:', clientId);
      return res.status(404).json({ 
        success: false, 
        message: "Client not found" 
      });
    }

    // First check if human agent exists
    const existingAgent = await HumanAgent.findById(agentId);
    if (!existingAgent) {
      console.log('Human agent not found by ID:', agentId);
      return res.status(404).json({ 
        success: false, 
        message: "Human agent not found" 
      });
    }

    // Check if human agent belongs to this client
    if (existingAgent.clientId.toString() !== clientId.toString()) {
      console.log('Human agent does not belong to client. Agent clientId:', existingAgent.clientId, 'Request clientId:', clientId);
      return res.status(403).json({ 
        success: false, 
        message: "Access denied - human agent does not belong to this client" 
      });
    }

    // Delete the human agent
    const humanAgent = await HumanAgent.findOneAndDelete({ 
      _id: agentId, 
      clientId 
    });

    // Also delete the associated profile
    const deletedProfile = await Profile.findOneAndDelete({ 
      humanAgentId: agentId 
    });

    console.log('Deleted human agent:', humanAgent ? 'Yes' : 'No');
    console.log('Deleted associated profile:', deletedProfile ? 'Yes' : 'No');

    res.json({ 
      success: true, 
      message: "Human agent and associated profile deleted successfully" 
    });
  } catch (error) {
    console.error("Error deleting human agent:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to delete human agent" 
    });
  }
};

// Get single human agent
const getHumanAgentById = async (req, res) => {
  try {
    // Extract clientId from token
    const clientId = req.clientId;
    const { agentId } = req.params;

    // Verify client exists
    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ 
        success: false, 
        message: "Client not found" 
      });
    }

    const humanAgent = await HumanAgent.findOne({ 
      _id: agentId, 
      clientId 
    }).populate('agentIds', 'agentName description');

    if (!humanAgent) {
      return res.status(404).json({ 
        success: false, 
        message: "Human agent not found" 
      });
    }

    res.json({ 
      success: true, 
      data: humanAgent 
    });
  } catch (error) {
    console.error("Error fetching human agent:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch human agent" 
    });
  }
};

// Human Agent Login
const loginHumanAgent = async (req, res) => {
  try {
    const { email, clientEmail } = req.body;

    console.log('Human agent login attempt for email:', email, 'clientEmail:', clientEmail);

    if (!email || !clientEmail) {
      console.log('Missing credentials for human agent login');
      return res.status(400).json({
        success: false,
        message: "Email and Client Email are required"
      });
    }

    // First verify the client exists by email
    const client = await Client.findOne({ email: clientEmail.toLowerCase() });
    if (!client) {
      console.log('Client not found for clientEmail:', clientEmail);
      return res.status(401).json({ 
        success: false, 
        message: "Invalid Client Email" 
      });
    }

    // Check if human agent exists with this email and clientId
    const humanAgent = await HumanAgent.findOne({ 
      email: email.toLowerCase(),
      clientId: client._id 
    });

    if (!humanAgent) {
      console.log('Human agent not found for email:', email, 'clientId:', client._id);
      return res.status(401).json({ 
        success: false, 
        message: "Human agent not found. Please check your email and Client Email." 
      });
    }

    // Check if human agent is approved
    if (!humanAgent.isApproved) {
      console.log('Human agent not approved:', humanAgent._id);
      return res.status(401).json({ 
        success: false, 
        message: "Your account is not yet approved. Please contact your administrator." 
      });
    }

    console.log('Human agent login successful:', humanAgent._id);

    // Get profile information for human agent and client
    let humanAgentProfileId = await Profile.findOne({humanAgentId: humanAgent._id});
    let clientProfileId = await Profile.findOne({clientId: client._id});

    // Generate token for human agent
    const token = jwt.sign(
      { 
        id: humanAgent._id, 
        userType: 'humanAgent',
        clientId: client._id,
        email: humanAgent.email
      }, 
      process.env.JWT_SECRET, 
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      message: "Human agent login successful",
      token,
      humanAgent: {
        _id: humanAgent._id,
        humanAgentName: humanAgent.humanAgentName,
        email: humanAgent.email,
        mobileNumber: humanAgent.mobileNumber,
        did: humanAgent.did,
        isprofileCompleted: humanAgent.isprofileCompleted,
        isApproved: humanAgent.isApproved,
        clientId: humanAgent.clientId,
        agentIds: humanAgent.agentIds,
        profileId: humanAgentProfileId ? humanAgentProfileId._id : null
      },
      client: {
        _id: client._id,
        clientName: client.clientName,
        email: client.email,
        profileId: clientProfileId ? clientProfileId._id : null
      }
    });

  } catch (error) {
    console.error("Error in human agent login:", error);
    res.status(500).json({
      success: false,
      message: "Login failed. Please try again."
    });
  }
};

// Human Agent Google Login
const loginHumanAgentGoogle = async (req, res) => {
  try {
    const { token } = req.body;

    console.log('Human agent Google login attempt');

    if (!token) {
      console.log('Missing Google token for human agent login');
      return res.status(400).json({
        success: false,
        message: "Google token is required"
      });
    }

    // Verify Google token and extract email
    try {
      const audience = [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_ANDROID_CLIENT_ID].filter(Boolean);
      console.log('Audience for Google verification:', audience);
      
      // Verify the Google ID token
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: audience,
      });

      const payload = ticket.getPayload();
      console.log('Google token verified, payload:', payload);
      
      if (!payload || !payload.email) {
        console.log('Invalid Google token or missing email');
        return res.status(401).json({ 
          success: false, 
          message: "Invalid Google token" 
        });
      }

      const humanAgentEmail = payload.email.toLowerCase();
      console.log('Looking for human agent with email:', humanAgentEmail);

      // Find human agent with this email
      const humanAgent = await HumanAgent.findOne({ 
        email: humanAgentEmail 
      }).populate('clientId');

          if (!humanAgent) {
        console.log('Human agent not found for email:', humanAgentEmail);
        return res.status(401).json({ 
          success: false, 
          message: "Human agent not found. Please contact your administrator to register your email." 
        });
      }

      // Check if human agent is approved
      if (!humanAgent.isApproved) {
        console.log('Human agent not approved:', humanAgent._id);
        return res.status(401).json({ 
          success: false, 
          message: "Your account is not yet approved. Please contact your administrator." 
        });
      }

      // Get client information
      const client = await Client.findById(humanAgent.clientId);
      if (!client) {
        console.log('Client not found for human agent:', humanAgent._id);
        return res.status(401).json({ 
          success: false, 
          message: "Associated client not found" 
        });
      }

      // Get profile information for human agent
      let humanAgentProfileId = await Profile.findOne({humanAgentId: humanAgent._id});
      let clientProfileId = await Profile.findOne({clientId: client._id});

      console.log('Human agent Google login successful:', humanAgent._id);

      // Generate token for human agent
      const jwtToken = jwt.sign(
        { 
          id: humanAgent._id, 
          userType: 'humanAgent',
          clientId: client._id,
          email: humanAgent.email
        }, 
        process.env.JWT_SECRET, 
        { expiresIn: "7d" }
      );

      res.json({
        success: true,
        message: "Human agent Google login successful",
        token: jwtToken,
        humanAgent: {
          _id: humanAgent._id,
          humanAgentName: humanAgent.humanAgentName,
          email: humanAgent.email,
          mobileNumber: humanAgent.mobileNumber,
          did: humanAgent.did,
          isprofileCompleted: humanAgent.isprofileCompleted,
          isApproved: humanAgent.isApproved,
          clientId: humanAgent.clientId,
          agentIds: humanAgent.agentIds,
          profileId: humanAgentProfileId ? humanAgentProfileId._id : null
        },
        client: {
          _id: client._id,
          clientName: client.clientName,
          email: client.email,
          profileId: clientProfileId ? clientProfileId._id : null
        }
      });

    } catch (googleError) {
      console.error('Google token verification error:', googleError);
      return res.status(401).json({
        success: false,
        message: "Invalid Google token"
      });
    }

  } catch (error) {
    console.error("Error in human agent Google login:", error);
    res.status(500).json({
      success: false,
      message: "Google login failed. Please try again."
    });
  }
};

// Assign campaign history contacts to human agents
const assignCampaignHistoryContactsToHumanAgents = async (req, res) => {
  try {
    const { id: campaignId, runId } = req.params;
    const { contactIds, humanAgentIds } = req.body;
    
    // Validate required fields
    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'contactIds array is required and must not be empty'
      });
    }
    
    if (!humanAgentIds || !Array.isArray(humanAgentIds) || humanAgentIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'humanAgentIds array is required and must not be empty'
      });
    }
    
    // Validate that the campaign exists and belongs to the client
    const Campaign = require('../models/Campaign');
    const campaign = await Campaign.findOne({ _id: campaignId, clientId: req.clientId });
    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found'
      });
    }
    
    // Validate that the campaign history exists
    const CampaignHistory = require('../models/CampaignHistory');
    const campaignHistory = await CampaignHistory.findOne({ 
      campaignId: campaignId, 
      runId: runId 
    });
    
    if (!campaignHistory) {
      return res.status(404).json({
        success: false,
        error: 'Campaign history not found'
      });
    }
    
    // Validate that all human agents exist and belong to the client
    const HumanAgent = require('../models/HumanAgent');
    const humanAgents = await HumanAgent.find({ 
      _id: { $in: humanAgentIds }, 
      clientId: req.clientId,
      isApproved: true
    });
    
    if (humanAgents.length !== humanAgentIds.length) {
      return res.status(400).json({
        success: false,
        error: 'Some human agents not found or not approved'
      });
    }
    
    // Validate that all contacts exist in the campaign history
    const existingContactIds = campaignHistory.contacts.map(c => String(c._id));
    const invalidContactIds = contactIds.filter(id => !existingContactIds.includes(String(id)));
    
    if (invalidContactIds.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Some contacts not found in campaign history: ${invalidContactIds.join(', ')}`
      });
    }
    
    // Update contacts with human agent assignments
    const assignmentData = humanAgentIds.map(humanAgentId => ({
      humanAgentId: humanAgentId,
      assignedAt: new Date(),
      assignedBy: req.clientId
    }));
    
    // Update each contact with the new assignments
    const updatePromises = contactIds.map(contactId => {
      return CampaignHistory.updateOne(
        { 
          campaignId: campaignId, 
          runId: runId,
          'contacts._id': contactId 
        },
        { 
          $push: { 
            'contacts.$.assignedToHumanAgents': { $each: assignmentData }
          } 
        }
      );
    });
    
    await Promise.all(updatePromises);
    
    // Get updated campaign history with populated human agent data
    const updatedHistory = await CampaignHistory.findOne({ 
      campaignId: campaignId, 
      runId: runId 
    }).populate('contacts.assignedToHumanAgents.humanAgentId', 'humanAgentName email role');
    
    // Filter only the assigned contacts for response
    const assignedContacts = updatedHistory.contacts.filter(contact => 
      contactIds.includes(String(contact._id))
    );
    
    res.json({
      success: true,
      message: `Successfully assigned ${contactIds.length} contact(s) to ${humanAgentIds.length} human agent(s)`,
      data: {
        assignedContactsCount: contactIds.length,
        assignedHumanAgentsCount: humanAgentIds.length,
        humanAgents: humanAgents.map(agent => ({
          _id: agent._id,
          humanAgentName: agent.humanAgentName,
          email: agent.email,
          role: agent.role
        })),
        assignedContacts: assignedContacts.map(contact => ({
          _id: contact._id,
          documentId: contact.documentId,
          number: contact.number,
          name: contact.name,
          leadStatus: contact.leadStatus,
          status: contact.status,
          assignedToHumanAgents: contact.assignedToHumanAgents
        }))
      }
    });
    
  } catch (error) {
    console.error('Error assigning campaign history contacts to human agents:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while assigning contacts'
    });
  }
};

module.exports = { 
  getUploadUrl,
  getUploadUrlMyBusiness,
  getUploadUrlCustomization,
  getUploadUrlKnowledgeBase,
  getFileUrlByKey,
  createKnowledgeItem,
  getKnowledgeItems,
  updateKnowledgeItem,
  deleteKnowledgeItem,
  embedKnowledgeItem,
  loginClient, 
  googleLogin,
  registerClient,
  getClientProfile,
  getHumanAgents,
  createHumanAgent,
  updateHumanAgent,
  deleteHumanAgent,
  getHumanAgentById,
  loginHumanAgent,
  loginHumanAgentGoogle,
    assignCampaignHistoryContactsToHumanAgents,
  googleListApprovedProfiles,
  googleSelectProfile,
  listApprovedProfilesForCurrentUser,
  switchProfile,
  getHumanAgentToken
};
