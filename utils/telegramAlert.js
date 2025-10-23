const axios = require('axios');

const TELEGRAM_ALERT_URL = 'https://telegram-bot-alert-module.onrender.com/api/telegram/send-text';

/**
 * Send a simple text alert to Telegram group.
 * Swallows errors to avoid impacting business flows.
 * @param {string} text
 */
async function sendTelegramAlert(text) {
  try {
    if (!text || typeof text !== 'string' || !text.trim()) return;
    await axios.post(TELEGRAM_ALERT_URL, { text });
  } catch (err) {
    // log once, but do not throw
    try {
      console.warn('Telegram alert failed:', err?.message);
    } catch (_) {}
  }
}

/**
 * Convenience helper: campaign start alert with emojis.
 * mode: 'serial' | 'parallel'
 * Accepts extended fields and renders full summary.
 */
async function sendCampaignStartAlert(payload = {}) {
  const when = payload.startTime ? new Date(payload.startTime) : new Date();
  const modeEmoji = payload.mode === 'parallel' ? '🟦' : '🟩';
  const lines = [
    `🚀 Campaign Started ${modeEmoji}`,
    `📛 ${payload.campaignName || 'N/A'}`,
    `🧑‍💼 Agent: ${payload.agentName || 'N/A'}`,
    `👥 Group: ${payload.groupName || 'N/A'}`,
    `☎️ DID: ${payload.did || 'N/A'}`,
    `📦 Total Contacts: ${payload.totalContacts ?? 'N/A'}`,
    `🕒 Start: ${when.toLocaleString('en-IN', { hour12: false })}`,
    `🏳️ Status: Running`,
    `🏢 Client: ${payload.clientName || 'N/A'}`,
    `📧 User: ${payload.loginEmail || 'N/A'}`,
    `🏷️ Mode: ${payload.mode || 'N/A'}`,
  ];
  await sendTelegramAlert(lines.join('\n'));
}

function formatDuration(ms = 0) {
  try {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  } catch (_) { return '00:00:00'; }
}

/**
 * Campaign stop alert. Call this AFTER campaign history is saved so stats are available.
 * Expects:
 * {
 *  campaignName, agentName, groupName, totalContacts,
 *  startTime, endTime, clientName, loginEmail,
 *  totalConnected, totalNotConnected, connectedPercent,
 *  mode, campaignId, durationMs
 * }
 */
async function sendCampaignStopAlert(payload = {}) {
  const whenEnd = payload.endTime ? new Date(payload.endTime) : new Date();
  const whenStart = payload.startTime ? new Date(payload.startTime) : null;
  const duration = payload.durationMs != null && !isNaN(payload.durationMs)
    ? formatDuration(payload.durationMs)
    : whenStart ? formatDuration(whenEnd - whenStart) : 'N/A';
  const modeEmoji = payload.mode === 'parallel' ? '🟦' : '🟩';
  const connectedPct = typeof payload.connectedPercent === 'number'
    ? `${payload.connectedPercent}%`
    : (payload.totalContacts ? `${Math.round(((payload.totalConnected||0) / payload.totalContacts) * 100)}%` : '0%');
  const lines = [
    `🛑 Campaign Ended ${modeEmoji}`,
    `📛 ${payload.campaignName || 'N/A'}`,
    `🆔 ${payload.campaignId || 'N/A'}`,
    `🧑‍💼 Agent: ${payload.agentName || 'N/A'}`,
    `👥 Group: ${payload.groupName || 'N/A'}`,
    `☎️ DID: ${payload.did || 'N/A'}`,
    `📦 Total Contacts: ${payload.totalContacts ?? 'N/A'}`,
    `🕒 Start: ${whenStart ? whenStart.toLocaleString('en-IN', { hour12: false }) : 'N/A'}`,
    `🕘 End: ${whenEnd.toLocaleString('en-IN', { hour12: false })}`,
    `⏱️ Duration: ${duration}`,
    `📈 Connected: ${payload.totalConnected ?? 0}`,
    `📉 Missed: ${payload.totalNotConnected ?? 0}`,
    `📊 Connected %: ${connectedPct}`,
    `🏷️ Mode: ${payload.mode || 'N/A'}`,
    `🏢 Client: ${payload.clientName || 'N/A'}`,
    `📧 User: ${payload.loginEmail || 'N/A'}`,
  ];
  await sendTelegramAlert(lines.join('\n'));
}

module.exports = { sendTelegramAlert, sendCampaignStartAlert, sendCampaignStopAlert };


