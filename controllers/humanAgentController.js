const CallLog = require('../models/CallLog');
const Client = require('../models/Client');
const Group = require('../models/Group');
const Campaign = require('../models/Campaign');
const Agent = require('../models/Agent');
const { makeSingleCall, startCampaignCalling } = require('../services/campaignCallingService');

// Resolve the canonical client ID used in Group/Campaign documents (string userId)
async function resolveClientUserId(user) {
    // In tokens: clients often have userId string; humanAgents often carry Client _id (ObjectId)
    const candidate = user?.clientId;
    // If it's a non-ObjectId string (likely already userId), return as-is
    if (typeof candidate === 'string' && candidate && candidate.length !== 24) {
        return candidate;
    }
    // Otherwise look up the Client document by _id and return its userId
    try {
        const clientDoc = await Client.findById(candidate).select('userId').lean();
        if (clientDoc?.userId) return clientDoc.userId;
    } catch (_) {}
    // Fallback to string form of candidate
    return String(candidate || '');
}

function uniqueNonEmpty(values = []) {
    const set = new Set();
    const out = [];
    for (const v of values) {
        const s = String(v || '').trim();
        if (!s) continue;
        if (!set.has(s)) { set.add(s); out.push(s); }
    }
    return out;
}

async function getClientIdCandidates(user) {
    const rawFromToken = String(user?.clientId || '');
    const resolvedUserId = await resolveClientUserId(user);
    return uniqueNonEmpty([rawFromToken, resolvedUserId]);
}

// Build date filter helper identical to client routes behavior
function buildDateFilter(filter, startDate, endDate) {
	let dateFilter = {};
	if (filter === 'today') {
		const today = new Date();
		const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
		const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
		dateFilter = { createdAt: { $gte: startOfDay, $lte: endOfDay } };
	} else if (filter === 'yesterday') {
		const today = new Date();
		const yesterday = new Date(today.getTime() - (24 * 60 * 60 * 1000));
		const startOfYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
		const endOfYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999);
		dateFilter = { createdAt: { $gte: startOfYesterday, $lte: endOfYesterday } };
	} else if (filter === 'last7days') {
		const today = new Date();
		const sevenDaysAgo = new Date(today.getTime() - (7 * 24 * 60 * 60 * 1000));
		dateFilter = { createdAt: { $gte: sevenDaysAgo, $lte: today } };
	} else if (startDate && endDate) {
		const start = new Date(startDate);
		const end = new Date(endDate);
		end.setHours(23, 59, 59, 999);
		dateFilter = { createdAt: { $gte: start, $lte: end } };
	}
	return dateFilter;
}

function validateFilter(filter, startDate, endDate) {
	const allowedFilters = ['today', 'yesterday', 'last7days'];
	if (filter && !allowedFilters.includes(filter) && (!startDate || !endDate)) {
		return {
			success: false,
			error: 'Invalid filter parameter',
			message: `Filter must be one of: ${allowedFilters.join(', ')} or provide both startDate and endDate`,
			allowedFilters
		};
	}
	return null;
}

exports.getInboundReport = async (req, res) => {
	try {
		const user = req.user;
		const { filter, startDate, endDate } = req.query;
		const validation = validateFilter(filter, startDate, endDate);
		if (validation) return res.status(400).json(validation);

		const clientId = user.clientId; // For client token it's client.userId; for human agent it's humanAgent.clientId
		const teamId = user.userType === 'humanAgent' ? String(user.id) : req.query.teamId; // allow client to pass teamId explicitly

		const dateFilter = buildDateFilter(filter, startDate, endDate);
		const query = {
			clientId,
			'metadata.callDirection': 'inbound',
			...(teamId ? { 'metadata.customParams.teamId': String(teamId) } : {}),
			...dateFilter
		};

		const logs = await CallLog.find(query).sort({ createdAt: -1 });
		const totalCalls = logs.length;
		const totalConnected = logs.filter(l => l.leadStatus !== 'not_connected').length;
		const totalNotConnected = logs.filter(l => l.leadStatus === 'not_connected').length;
		const totalConversationTime = logs.reduce((sum, l) => sum + (l.duration || 0), 0);
		const avgCallDuration = totalCalls ? totalConversationTime / totalCalls : 0;

		return res.json({
			success: true,
			data: { clientId, teamId: teamId || null, totalCalls, totalConnected, totalNotConnected, totalConversationTime, avgCallDuration },
			filter: { applied: filter || 'all', startDate: dateFilter.createdAt?.$gte, endDate: dateFilter.createdAt?.$lte }
		});
	} catch (error) {
		console.error('Error in humanAgent inbound report:', error);
		return res.status(500).json({ success: false, error: 'Failed to fetch report' });
	}
};

exports.getOutboundReport = async (req, res) => {
	try {
		const user = req.user;
		const { filter, startDate, endDate } = req.query;
		const validation = validateFilter(filter, startDate, endDate);
		if (validation) return res.status(400).json(validation);

		const clientId = user.clientId;
		const teamId = user.userType === 'humanAgent' ? String(user.id) : req.query.teamId;

		const dateFilter = buildDateFilter(filter, startDate, endDate);
		const query = {
			clientId,
			'metadata.callDirection': 'outbound',
			...(teamId ? { 'metadata.customParams.teamId': String(teamId) } : {}),
			...dateFilter
		};

		const logs = await CallLog.find(query).sort({ createdAt: -1 });
		const totalCalls = logs.length;
		const totalConnected = logs.filter(l => l.leadStatus !== 'not_connected').length;
		const totalNotConnected = logs.filter(l => l.leadStatus === 'not_connected').length;
		const totalConversationTime = logs.reduce((sum, l) => sum + (l.duration || 0), 0);
		const avgCallDuration = totalCalls ? totalConversationTime / totalCalls : 0;

		return res.json({
			success: true,
			data: { clientId, teamId: teamId || null, totalCalls, totalConnected, totalNotConnected, totalConversationTime, avgCallDuration },
			filter: { applied: filter || 'all', startDate: dateFilter.createdAt?.$gte, endDate: dateFilter.createdAt?.$lte }
		});
	} catch (error) {
		console.error('Error in humanAgent outbound report:', error);
		return res.status(500).json({ success: false, error: 'Failed to fetch report' });
	}
};

exports.getInboundLogs = async (req, res) => {
	try {
		const user = req.user;
		const { filter, startDate, endDate, page = 1, limit = 20 } = req.query;
		const validation = validateFilter(filter, startDate, endDate);
		if (validation) return res.status(400).json(validation);

		const clientId = user.clientId;
		const teamId = user.userType === 'humanAgent' ? String(user.id) : req.query.teamId;
		const dateFilter = buildDateFilter(filter, startDate, endDate);

		const query = {
			clientId,
			'metadata.callDirection': 'inbound',
			...(teamId ? { 'metadata.customParams.teamId': String(teamId) } : {}),
			...dateFilter
		};

		const pageNum = parseInt(page);
		const limitNum = parseInt(limit);
		const skip = (pageNum - 1) * limitNum;

		const clientName = await Client.findOne({ _id: clientId }).select('name');
		const totalCount = await CallLog.countDocuments(query);
		const logs = await CallLog.find(query)
			.sort({ createdAt: -1 })
			.populate('agentId', 'agentName')
			.skip(skip)
			.limit(limitNum)
			.lean();

		const logsWithAgentName = logs.map(l => ({
			...l,
			agentName: l.agentId && l.agentId.agentName ? l.agentId.agentName : null,
		}));

		const totalPages = Math.ceil(totalCount / limitNum);
		const hasNextPage = pageNum < totalPages;
		const hasPrevPage = pageNum > 1;

		return res.json({
			success: true,
			clientName,
			data: logsWithAgentName,
			pagination: {
				currentPage: pageNum,
				totalPages,
				totalItems: totalCount,
				itemsPerPage: limitNum,
				hasNextPage,
				hasPrevPage,
				nextPage: hasNextPage ? pageNum + 1 : null,
				prevPage: hasPrevPage ? pageNum - 1 : null
			}
		});
	} catch (error) {
		console.error('Error in humanAgent inbound logs:', error);
		return res.status(500).json({ success: false, error: 'Failed to fetch logs' });
	}
};

exports.getOutboundLogs = async (req, res) => {
	try {
		const user = req.user;
		const { filter, startDate, endDate, page = 1, limit = 20 } = req.query;
		const validation = validateFilter(filter, startDate, endDate);
		if (validation) return res.status(400).json(validation);

		const clientId = user.clientId;
		const teamId = user.userType === 'humanAgent' ? String(user.id) : req.query.teamId;
		const dateFilter = buildDateFilter(filter, startDate, endDate);

		const query = {
			clientId,
			'metadata.callDirection': 'outbound',
			...(teamId ? { 'metadata.customParams.teamId': String(teamId) } : {}),
			...dateFilter
		};

		const pageNum = parseInt(page);
		const limitNum = parseInt(limit);
		const skip = (pageNum - 1) * limitNum;

		const clientName = await Client.findOne({ _id: clientId }).select('name');
		const totalCount = await CallLog.countDocuments(query);
		const logs = await CallLog.find(query)
			.sort({ createdAt: -1 })
			.populate('agentId', 'agentName')
			.skip(skip)
			.limit(limitNum)
			.lean();

		const logsWithAgentName = logs.map(l => ({
			...l,
			agentName: l.agentId && l.agentId.agentName ? l.agentId.agentName : null,
		}));

		const totalPages = Math.ceil(totalCount / limitNum);
		const hasNextPage = pageNum < totalPages;
		const hasPrevPage = pageNum > 1;

		return res.json({
			success: true,
			clientName,
			data: logsWithAgentName,
			pagination: {
				currentPage: pageNum,
				totalPages,
				totalItems: totalCount,
				itemsPerPage: limitNum,
				hasNextPage,
				hasPrevPage,
				nextPage: hasNextPage ? pageNum + 1 : null,
				prevPage: hasPrevPage ? pageNum - 1 : null
			}
		});
	} catch (error) {
		console.error('Error in humanAgent outbound logs:', error);
		return res.status(500).json({ success: false, error: 'Failed to fetch logs' });
	}
};

exports.getInboundLeads = async (req, res) => {
	try {
		const user = req.user;
		const { filter, startDate, endDate } = req.query;
		const validation = validateFilter(filter, startDate, endDate);
		if (validation) return res.status(400).json(validation);

		const clientId = user.clientId;
		const teamId = user.userType === 'humanAgent' ? String(user.id) : req.query.teamId;
		const dateFilter = buildDateFilter(filter, startDate, endDate);

		const query = {
			clientId,
			'metadata.callDirection': 'inbound',
			...(teamId ? { 'metadata.customParams.teamId': String(teamId) } : {}),
			...dateFilter
		};

		const logs = await CallLog.find(query).sort({ createdAt: -1 });
		const leads = {
			veryInterested: {
				data: logs.filter(l => l.leadStatus === 'vvi' || l.leadStatus === 'very_interested'),
				count: logs.filter(l => l.leadStatus === 'vvi' || l.leadStatus === 'very_interested').length
			},
			maybe: {
				data: logs.filter(l => l.leadStatus === 'maybe' || l.leadStatus === 'medium'),
				count: logs.filter(l => l.leadStatus === 'maybe' || l.leadStatus === 'medium').length
			},
			enrolled: {
				data: logs.filter(l => l.leadStatus === 'enrolled'),
				count: logs.filter(l => l.leadStatus === 'enrolled').length
			},
			junkLead: { data: logs.filter(l => l.leadStatus === 'junk_lead'), count: logs.filter(l => l.leadStatus === 'junk_lead').length },
			notRequired: { data: logs.filter(l => l.leadStatus === 'not_required'), count: logs.filter(l => l.leadStatus === 'not_required').length },
			enrolledOther: { data: logs.filter(l => l.leadStatus === 'enrolled_other'), count: logs.filter(l => l.leadStatus === 'enrolled_other').length },
			decline: { data: logs.filter(l => l.leadStatus === 'decline'), count: logs.filter(l => l.leadStatus === 'decline').length },
			notEligible: { data: logs.filter(l => l.leadStatus === 'not_eligible'), count: logs.filter(l => l.leadStatus === 'not_eligible').length },
			wrongNumber: { data: logs.filter(l => l.leadStatus === 'wrong_number'), count: logs.filter(l => l.leadStatus === 'wrong_number').length },
			hotFollowup: { data: logs.filter(l => l.leadStatus === 'hot_followup'), count: logs.filter(l => l.leadStatus === 'hot_followup').length },
			coldFollowup: { data: logs.filter(l => l.leadStatus === 'cold_followup'), count: logs.filter(l => l.leadStatus === 'cold_followup').length },
			schedule: { data: logs.filter(l => l.leadStatus === 'schedule'), count: logs.filter(l => l.leadStatus === 'schedule').length },
			notConnected: { data: logs.filter(l => l.leadStatus === 'not_connected'), count: logs.filter(l => l.leadStatus === 'not_connected').length }
		};

		return res.json({
			success: true,
			data: leads,
			filter: { applied: filter || 'all', startDate: dateFilter.createdAt?.$gte, endDate: dateFilter.createdAt?.$lte }
		});
	} catch (error) {
		console.error('Error in humanAgent inbound leads:', error);
		return res.status(500).json({ success: false, error: 'Failed to fetch leads' });
	}
};

exports.getOutboundLeads = async (req, res) => {
	try {
		const user = req.user;
		const { filter, startDate, endDate } = req.query;
		const validation = validateFilter(filter, startDate, endDate);
		if (validation) return res.status(400).json(validation);

		const clientId = user.clientId;
		const teamId = user.userType === 'humanAgent' ? String(user.id) : req.query.teamId;
		const dateFilter = buildDateFilter(filter, startDate, endDate);

		const query = {
			clientId,
			'metadata.callDirection': 'outbound',
			...(teamId ? { 'metadata.customParams.teamId': String(teamId) } : {}),
			...dateFilter
		};

		const logs = await CallLog.find(query).sort({ createdAt: -1 });
		const leads = {
			veryInterested: {
				data: logs.filter(l => l.leadStatus === 'vvi' || l.leadStatus === 'very_interested'),
				count: logs.filter(l => l.leadStatus === 'vvi' || l.leadStatus === 'very_interested').length
			},
			maybe: {
				data: logs.filter(l => l.leadStatus === 'maybe' || l.leadStatus === 'medium'),
				count: logs.filter(l => l.leadStatus === 'maybe' || l.leadStatus === 'medium').length
			},
			enrolled: {
				data: logs.filter(l => l.leadStatus === 'enrolled'),
				count: logs.filter(l => l.leadStatus === 'enrolled').length
			},
			junkLead: { data: logs.filter(l => l.leadStatus === 'junk_lead'), count: logs.filter(l => l.leadStatus === 'junk_lead').length },
			notRequired: { data: logs.filter(l => l.leadStatus === 'not_required'), count: logs.filter(l => l.leadStatus === 'not_required').length },
			enrolledOther: { data: logs.filter(l => l.leadStatus === 'enrolled_other'), count: logs.filter(l => l.leadStatus === 'enrolled_other').length },
			decline: { data: logs.filter(l => l.leadStatus === 'decline'), count: logs.filter(l => l.leadStatus === 'decline').length },
			notEligible: { data: logs.filter(l => l.leadStatus === 'not_eligible'), count: logs.filter(l => l.leadStatus === 'not_eligible').length },
			wrongNumber: { data: logs.filter(l => l.leadStatus === 'wrong_number'), count: logs.filter(l => l.leadStatus === 'wrong_number').length },
			hotFollowup: { data: logs.filter(l => l.leadStatus === 'hot_followup'), count: logs.filter(l => l.leadStatus === 'hot_followup').length },
			coldFollowup: { data: logs.filter(l => l.leadStatus === 'cold_followup'), count: logs.filter(l => l.leadStatus === 'cold_followup').length },
			schedule: { data: logs.filter(l => l.leadStatus === 'schedule'), count: logs.filter(l => l.leadStatus === 'schedule').length },
			notConnected: { data: logs.filter(l => l.leadStatus === 'not_connected'), count: logs.filter(l => l.leadStatus === 'not_connected').length }
		};

		return res.json({
			success: true,
			data: leads,
			filter: { applied: filter || 'all', startDate: dateFilter.createdAt?.$gte, endDate: dateFilter.createdAt?.$lte }
		});
	} catch (error) {
		console.error('Error in humanAgent outbound leads:', error);
		return res.status(500).json({ success: false, error: 'Failed to fetch leads' });
	}
};

// ============ Human Agent: Groups (reuse client logic with clientId from token) ============
exports.createGroup = async (req, res) => {
	try {
        const clientId = await resolveClientUserId(req.user);
		const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
		const ownerId = req.user.id;
		const { name, category, description } = req.body;
		if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Group name is required' });
		const groupNameMatch = await Group.findOne({ name: { $regex: name.trim(), $options: 'i' }, clientId, ownerType, ownerId });
		if (groupNameMatch) return res.status(400).json({ success: false, error: 'Group name already exists' });
		const group = new Group({ name: name.trim(), category: category?.trim() || '', description: description?.trim() || '', clientId, contacts: [], ownerType, ownerId });
		await group.save();
		return res.status(201).json({ success: true, data: group });
	} catch (e) {
		console.error('Error creating group (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to create group' });
	}
};

exports.listGroups = async (req, res) => {
	try {
        const candidates = await getClientIdCandidates(req.user);
        const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
        const ownerId = new (require('mongoose')).Types.ObjectId(String(req.user.id));
        
        // Show groups owned by the current actor OR groups assigned to the current human agent
        const groups = await Group.aggregate([
            { 
                $match: { 
                    clientId: { $in: candidates },
                    $or: [
                        { ownerType, ownerId }, // Groups owned by current actor
                        { assignedHumanAgents: ownerId } // Groups assigned to current human agent
                    ]
                } 
            },
			{ $sort: { createdAt: -1 } },
			{
				$lookup: {
					from: 'humanagents',
					localField: 'assignedHumanAgents',
					foreignField: '_id',
					as: 'assignedHumanAgentsData'
				}
			},
			{
				$lookup: {
					from: 'humanagents',
					localField: 'ownerId',
					foreignField: '_id',
					as: 'ownerData'
				}
			},
			{
				$project: { 
					name: 1, 
					category: 1, 
					description: 1, 
					clientId: 1,
					ownerType: 1,
					ownerId: 1,
					assignedHumanAgents: 1,
					assignedHumanAgentsData: {
						$map: {
							input: '$assignedHumanAgentsData',
							as: 'agent',
							in: {
								_id: '$$agent._id',
								humanAgentName: '$$agent.humanAgentName',
								email: '$$agent.email',
								role: '$$agent.role'
							}
						}
					},
					ownerData: {
						$map: {
							input: '$ownerData',
							as: 'owner',
							in: {
								_id: '$$owner._id',
								humanAgentName: '$$owner.humanAgentName',
								email: '$$owner.email',
								role: '$$owner.role'
							}
						}
					},
					createdAt: 1, 
					updatedAt: 1, 
					contactsCount: { $size: { $ifNull: ["$contacts", []] } } 
				} 
			}
		]);
		return res.json({ success: true, data: groups });
	} catch (e) {
		console.error('Error fetching groups (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to fetch groups' });
	}
};

exports.updateGroup = async (req, res) => {
	try {
        const clientId = await resolveClientUserId(req.user);
		const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
		const ownerId = req.user.id;
		const { id } = req.params;
		const { name, category, description } = req.body;
		if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Group name is required' });
		const groupNameMatch = await Group.findOne({ name: { $regex: name.trim(), $options: 'i' }, clientId, ownerType, ownerId, _id: { $ne: id } });
		if (groupNameMatch) return res.status(400).json({ success: false, error: 'Group name already exists' });
		const group = await Group.findOneAndUpdate({ _id: id, clientId, ownerType, ownerId }, { name: name.trim(), category: category?.trim() || '', description: description?.trim() || '', updatedAt: new Date() }, { new: true });
		if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
		return res.json({ success: true, data: group });
	} catch (e) {
		return res.status(500).json({ success: false, error: 'Failed to update group' });
	}
};

exports.getGroup = async (req, res) => {
	try {
        const candidates = await getClientIdCandidates(req.user);
        const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
        const ownerId = new (require('mongoose')).Types.ObjectId(String(req.user.id));
		const { id } = req.params;
        
        // Show group if owned by current actor OR assigned to current human agent
        const group = await Group.findOne({ 
            _id: id, 
            clientId: { $in: candidates },
            $or: [
                { ownerType, ownerId }, // Groups owned by current actor
                { assignedHumanAgents: ownerId } // Groups assigned to current human agent
            ]
        }).populate('assignedHumanAgents', 'humanAgentName email role');
        
		if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
		return res.json({ success: true, data: group });
	} catch (e) {
		console.error('Error fetching group (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to fetch group' });
	}
};

exports.deleteGroup = async (req, res) => {
	try {
        const clientId = await resolveClientUserId(req.user);
		const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
		const ownerId = req.user.id;
		const { id } = req.params;
		const r = await Group.findOneAndDelete({ _id: id, clientId, ownerType, ownerId });
		return res.json({ success: true, deleted: !!r });
	} catch (e) {
		return res.status(500).json({ success: false, error: 'Failed to delete group' });
	}
};

// ============ Human Agent: Group Contacts (secured by ownership) ============
exports.getGroupsContacts = async (req, res) =>{
	try {
		const { id } = req.params; // group id
		const group = await Group.findById(id);
		if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
		return res.json({ success: true, data: group.contacts || [] });
	} catch (e) {
		console.error('Error fetching group contacts (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to fetch group contacts' });
	}
}

exports.addContactToGroup = async (req, res) => {
	try {
		const candidates = await getClientIdCandidates(req.user);
		const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
		const ownerId = new (require('mongoose')).Types.ObjectId(String(req.user.id));
		const { id } = req.params; // group id
		const { name = '', phone, email = '' } = req.body || {};
		if (!phone || !String(phone).trim()) return res.status(400).json({ success: false, error: 'Phone is required' });
		const group = await Group.findOne({ _id: id, clientId: { $in: candidates }, ownerType, ownerId });
		if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
		group.contacts.push({ name: String(name).trim(), phone: String(phone).trim(), email: String(email || '').trim() });
		await group.save();
		return res.status(201).json({ success: true, data: group });
	} catch (e) {
		console.error('Error adding contact (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to add contact' });
	}
};

exports.bulkAddContactsToGroup = async (req, res) => {
	try {
		const candidates = await getClientIdCandidates(req.user);
		const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
		const ownerId = new (require('mongoose')).Types.ObjectId(String(req.user.id));
		const { id } = req.params; // group id
		const { contacts } = req.body || {};
		if (!Array.isArray(contacts) || contacts.length === 0) return res.status(400).json({ success: false, error: 'contacts array is required' });
		const group = await Group.findOne({ _id: id, clientId: { $in: candidates }, ownerType, ownerId });
		if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
		for (const c of contacts) {
			if (!c || !c.phone) continue;
			group.contacts.push({ name: String(c.name || '').trim(), phone: String(c.phone).trim(), email: String(c.email || '').trim() });
		}
		await group.save();
		return res.json({ success: true, data: group });
	} catch (e) {
		console.error('Error bulk adding contacts (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to import contacts' });
	}
};

exports.bulkDeleteContactsFromGroup = async (req, res) => {
	try {
		const candidates = await getClientIdCandidates(req.user);
		const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
		const ownerId = new (require('mongoose')).Types.ObjectId(String(req.user.id));
		const { id } = req.params; // group id
		const { contactIds } = req.body || {};
		if (!Array.isArray(contactIds) || contactIds.length === 0) return res.status(400).json({ success: false, error: 'contactIds array is required' });
		const group = await Group.findOne({ _id: id, clientId: { $in: candidates }, ownerType, ownerId });
		if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
		const set = new Set(contactIds.map(String));
		group.contacts = (group.contacts || []).filter(c => !set.has(String(c._id)));
		await group.save();
		return res.json({ success: true, data: { deleted: contactIds.length } });
	} catch (e) {
		console.error('Error bulk deleting contacts (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to delete contacts' });
	}
};

exports.deleteContactFromGroup = async (req, res) => {
	try {
		const candidates = await getClientIdCandidates(req.user);
		const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
		const ownerId = new (require('mongoose')).Types.ObjectId(String(req.user.id));
		const { id, contactId } = req.params;
		const group = await Group.findOne({ _id: id, clientId: { $in: candidates }, ownerType, ownerId });
		if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
		const before = (group.contacts || []).length;
		group.contacts = (group.contacts || []).filter(c => String(c._id) !== String(contactId));
		await group.save();
		return res.json({ success: true, data: { deleted: before - (group.contacts || []).length } });
	} catch (e) {
		console.error('Error deleting contact (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to delete contact' });
	}
};

// ============ Human Agent: Campaigns ============
exports.createCampaign = async (req, res) => {
	try {
        const clientId = await resolveClientUserId(req.user);
		const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
		const ownerId = req.user.id;
		const { name, description, groupIds, category, agent, isRunning } = req.body || {};
		if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Campaign name is required' });
		const campaignNameMatch = await Campaign.findOne({ name: { $regex: name.trim(), $options: 'i' }, clientId, ownerType, ownerId });
		if (campaignNameMatch) return res.status(400).json({ success: false, error: 'Campaign name already exists' });
		let agentArray = [];
		if (Array.isArray(agent)) {
			agentArray = agent.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean);
		} else if (typeof agent === 'string') {
			const val = agent.trim();
			agentArray = val ? [val] : [];
		}
		const campaign = new Campaign({ name: name.trim(), description: description?.trim() || '', groupIds: groupIds || [], clientId, category: category?.trim() || '', agent: agentArray, isRunning: isRunning || false, ownerType, ownerId });
		await campaign.save();
		return res.status(201).json({ success: true, data: campaign });
	} catch (e) {
		console.error('Error creating campaign (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to create campaign' });
	}
};

exports.attachGroupsToCampaign = async (req, res) => {
	try {
        const clientId = await resolveClientUserId(req.user);
		const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
		const ownerId = req.user.id;
		const { id } = req.params;
		const { groupIds } = req.body || {};
		if (!Array.isArray(groupIds)) return res.status(400).json({ success: false, error: 'groupIds array is required' });
		const campaign = await Campaign.findOne({ _id: id, clientId, ownerType, ownerId });
		if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
		const groups = await Group.find({ _id: { $in: groupIds }, clientId, ownerType, ownerId });
		if (groups.length !== groupIds.length) return res.status(400).json({ success: false, error: 'Some groups not found or don\'t belong to client' });
		campaign.groupIds = groupIds;
		await campaign.save();
		const updated = await Campaign.findById(campaign._id).populate('groupIds', 'name description');
		return res.json({ success: true, data: updated });
	} catch (e) {
		console.error('Error attaching groups (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to add groups to campaign' });
	}
};

exports.startCampaign = async (req, res) => {
	try {
        const clientId = await resolveClientUserId(req.user);
		const ownerType = req.user.userType === 'humanAgent' ? 'humanAgent' : 'client';
		const ownerId = req.user.id;
		const { id } = req.params;
		const { agentId, delayBetweenCalls = 2000 } = req.body || {};
		const campaign = await Campaign.findOne({ _id: id, clientId, ownerType, ownerId });
		if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
		// Credit check mirrors client route
		try {
			const Credit = require('../models/Credit');
			const creditRecord = await Credit.getOrCreateCreditRecord(clientId);
			const currentBalance = Number(creditRecord?.currentBalance || 0);
			if (currentBalance <= 0) {
				return res.status(402).json({ success: false, error: 'INSUFFICIENT_CREDITS', message: 'Not sufficient credits. Please recharge first to start calling.' });
			}
		} catch (e) {
			console.error('Credit check failed:', e);
			return res.status(500).json({ success: false, error: 'Credit check failed' });
		}
		if (!campaign.contacts || campaign.contacts.length === 0) return res.status(400).json({ success: false, error: 'No contacts in campaign to call' });
		if (campaign.isRunning) return res.status(400).json({ success: false, error: 'Campaign is already running' });
		// Resolve API key from Agent
		const agent = await Agent.findById(agentId).lean();
		if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
		const provider = String(agent?.serviceProvider || '').toLowerCase();
		let apiKey = '';
		if (provider === 'snapbx' || provider === 'sanpbx') {
			if (!agent?.accessToken || !agent?.accessKey || !agent?.callerId) {
				return res.status(400).json({ success: false, error: 'TELEPHONY MISSING FIELDS', message: 'accessToken, accessKey and callerId are required on agent for SANPBX' });
			}
		} else {
			apiKey = agent.X_API_KEY || '';
			if (!apiKey) {
				const { getClientApiKey } = require('../services/campaignCallingService');
				apiKey = await getClientApiKey(clientId);
				if (!apiKey) return res.status(400).json({ success: false, error: 'No API key found on agent or client' });
			}
		}
		// Mark running and start in background; pass teamId via extra custom params from human agent token
		campaign.isRunning = true;
		await campaign.save();
		const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const agentConfig = await require('../models/AgentConfig').findOne({ agentId }).lean();
		startCampaignCalling(campaign, agentId, apiKey, delayBetweenCalls, clientId, runId, agentConfig);
		return res.json({ success: true, message: 'Campaign calling started', data: { campaignId: campaign._id, totalContacts: campaign.contacts.length, status: 'started', runId } });
	} catch (e) {
		console.error('Error starting campaign (human-agent):', e);
		return res.status(500).json({ success: false, error: 'Failed to start campaign calling' });
	}
};

// ============ Human Agent: Single call with teamId injection ============
exports.singleCall = async (req, res) => {
	try {
		const clientId = req.user.clientId;
		const teamId = req.user.userType === 'humanAgent' ? String(req.user.id) : null;
		const { contact, agentId, apiKey, campaignId, uniqueid } = req.body || {};
		if (!contact) return res.status(400).json({ success: false, error: 'Missing contact (phone)' });
		if (!agentId) return res.status(400).json({ success: false, error: 'agentId is required' });
		// Resolve provider and apiKey similar to client route
		const agent = await Agent.findById(agentId).lean();
		if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
		const provider = String(agent?.serviceProvider || '').toLowerCase();
		let resolvedApiKey = apiKey;
		if (provider !== 'snapbx' && provider !== 'sanpbx') {
			if (!resolvedApiKey) {
				resolvedApiKey = agent.X_API_KEY || '';
				if (!resolvedApiKey) {
					const { getClientApiKey } = require('../services/campaignCallingService');
					resolvedApiKey = await getClientApiKey(clientId);
				}
				if (!resolvedApiKey) return res.status(400).json({ success: false, error: 'No API key found for agent or client' });
			}
		}
		const result = await makeSingleCall(
			{
				name: typeof contact === 'object' ? (contact.name || '') : (req.body?.name || ''),
				phone: typeof contact === 'string' ? contact : (contact && (contact.phone || contact.number))
			},
			agentId,
			resolvedApiKey,
			campaignId || null,
			clientId,
			null,
			uniqueid,
			teamId ? { teamId } : {}
		);
		return res.json({ success: true, data: result });
	} catch (e) {
		console.error('Human-agent single call failed:', e);
		return res.status(500).json({ success: false, error: 'Failed to initiate call' });
	}
};

// Export helper function
module.exports.resolveClientUserId = resolveClientUserId;


