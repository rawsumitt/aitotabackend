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
router.post('/groups/:groupId/assign', verifyClientOrHumanAgentToken, require('../controllers/humanAgentController').assignGroupToHumanAgents);

// Get human agents for assignment - accessible by clients
router.get('/human-agents', verifyClientOrHumanAgentToken, require('../controllers/humanAgentController').getHumanAgentsForAssignment);

module.exports = router;
