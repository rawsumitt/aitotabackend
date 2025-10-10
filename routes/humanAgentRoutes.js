const express = require('express');
const router = express.Router();
const { verifyClientOrHumanAgentToken } = require('../middlewares/authmiddleware');
const {
	getInboundReport,
	getOutboundReport,
	getInboundLogs,
	getOutboundLogs,
	getInboundLeads,
	getOutboundLeads,
	createGroup,
	listGroups,
	updateGroup,
	getGroup,
	deleteGroup,
  getGroupsContacts,
  addContactToGroup,
  bulkAddContactsToGroup,
  bulkDeleteContactsFromGroup,
  deleteContactFromGroup,
	createCampaign,
	attachGroupsToCampaign,
	startCampaign,
	singleCall
} = require('../controllers/humanAgentController');

// Import helper function
const { resolveClientUserId } = require('../controllers/humanAgentController');

// Reports
router.get('/inbound/report', verifyClientOrHumanAgentToken, getInboundReport);
router.get('/outbound/report', verifyClientOrHumanAgentToken, getOutboundReport);

// Logs
router.get('/inbound/logs', verifyClientOrHumanAgentToken, getInboundLogs);
router.get('/outbound/logs', verifyClientOrHumanAgentToken, getOutboundLogs);

// Leads
router.get('/inbound/leads', verifyClientOrHumanAgentToken, getInboundLeads);
router.get('/outbound/leads', verifyClientOrHumanAgentToken, getOutboundLeads);

// Groups (human-agent)
router.get('/groups', verifyClientOrHumanAgentToken, listGroups);
router.post('/groups', verifyClientOrHumanAgentToken, createGroup);
router.get('/groups/:id', verifyClientOrHumanAgentToken, getGroup);
router.put('/groups/:id', verifyClientOrHumanAgentToken, updateGroup);
router.delete('/groups/:id', verifyClientOrHumanAgentToken, deleteGroup);
// Contacts in group (human-agent secured)
router.get('/groups/:id/contacts', verifyClientOrHumanAgentToken, getGroupsContacts);
router.post('/groups/:id/contacts', verifyClientOrHumanAgentToken, addContactToGroup);
router.post('/groups/:id/contacts/bulk-add', verifyClientOrHumanAgentToken, bulkAddContactsToGroup);
router.post('/groups/:id/contacts/bulk-delete', verifyClientOrHumanAgentToken, bulkDeleteContactsFromGroup);
router.delete('/groups/:id/contacts/:contactId', verifyClientOrHumanAgentToken, deleteContactFromGroup);

// Campaigns (human-agent)
router.post('/campaigns', verifyClientOrHumanAgentToken, createCampaign);
router.post('/campaigns/:id/groups', verifyClientOrHumanAgentToken, attachGroupsToCampaign);
router.post('/campaigns/:id/start-calling', verifyClientOrHumanAgentToken, startCampaign);

// Single outbound call with teamId injection
router.post('/calls/single', verifyClientOrHumanAgentToken, singleCall);

// Assign group to human agents (teams) - accessible by clients
router.post('/groups/:groupId/assign', verifyClientOrHumanAgentToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { humanAgentIds } = req.body;
    
    if (!Array.isArray(humanAgentIds) || humanAgentIds.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'humanAgentIds array is required and must not be empty' 
      });
    }

    // Get client ID from token
    const clientId = await resolveClientUserId(req.user);
    
    // Validate that the group exists and belongs to the client
    const Group = require('../models/Group');
    const group = await Group.findOne({ _id: groupId, clientId });
    if (!group) {
      return res.status(404).json({ 
        success: false,
        error: 'Group not found' 
      });
    }

    // Validate that all human agents exist and belong to the client
    const HumanAgent = require('../models/HumanAgent');
    const humanAgents = await HumanAgent.find({ 
      _id: { $in: humanAgentIds }, 
      clientId 
    });
    
    if (humanAgents.length !== humanAgentIds.length) {
      return res.status(400).json({ 
        success: false,
        error: 'Some human agents not found or don\'t belong to client' 
      });
    }

    // Update the group with assigned human agents
    group.assignedHumanAgents = humanAgentIds;
    await group.save();

    // Populate the assigned human agents for response
    const updatedGroup = await Group.findById(groupId)
      .populate('assignedHumanAgents', 'humanAgentName email role')
      .lean();

    res.json({ 
      success: true, 
      data: updatedGroup,
      message: `Group assigned to ${humanAgentIds.length} human agent(s) successfully` 
    });
  } catch (error) {
    console.error('Error assigning group to human agents:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to assign group to human agents' 
    });
  }
});

// Get human agents for assignment - accessible by clients
router.get('/human-agents', verifyClientOrHumanAgentToken, async (req, res) => {
  try {
    // resolveClientUserId returns canonical client userId (string) in our system; 
    // HumanAgent.model uses ObjectId for clientId, so convert when possible
    const canonical = await resolveClientUserId(req.user);
    const mongoose = require('mongoose');
    let clientIdFilter;
    // If canonical looks like ObjectId, use it; otherwise map Client by userId first
    if (canonical && typeof canonical === 'string' && canonical.length === 24) {
      clientIdFilter = new mongoose.Types.ObjectId(canonical);
    } else {
      const Client = require('../models/Client');
      const clientDoc = await Client.findOne({ userId: canonical }).select('_id').lean();
      clientIdFilter = clientDoc?._id || null;
    }

    if (!clientIdFilter) {
      return res.json({ success: true, data: [] });
    }
    const HumanAgent = require('../models/HumanAgent');
    const humanAgents = await HumanAgent.find({ 
      clientId: clientIdFilter,
      isApproved: true 
    }).select('humanAgentName email role createdAt').lean();

    res.json({ 
      success: true, 
      data: humanAgents 
    });
  } catch (error) {
    console.error('Error fetching human agents:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch human agents' 
    });
  }
});

module.exports = router;
