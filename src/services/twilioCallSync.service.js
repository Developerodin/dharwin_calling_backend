/**
 * Twilio webhook → DB sync. Single chokepoint for Twilio call state updates.
 *
 * Reuses the existing Call / CallRecording / CallReport models and the shared
 * Socket.IO broadcast layer, so the mobile app's realtime contract is unchanged
 * (events: call-status-updated, recording-ready, call-history-updated).
 */

import Call, { rankOf, isTerminal } from '../models/call.model.js';
import CallRecording from '../models/callRecording.model.js';
import CallReport from '../models/callReport.model.js';
import twilioService from './twilio.service.js';
import twilioIntelligence from './twilioIntelligence.service.js';
import savedContactService from './savedContact.service.js';
import callEventLog from '../utils/callEventLog.js';
import { broadcastCallUpdate, broadcastRecordingReady } from '../socket/callBroadcast.js';

// Twilio CallStatus / DialCallStatus → canonical app status.
const TWILIO_STATUS_MAP = {
  queued: 'initiated',
  initiated: 'initiated',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  answered: 'in_progress',
  completed: 'completed',
  busy: 'busy',
  failed: 'failed',
  'no-answer': 'no_answer',
  canceled: 'canceled',
};

function normalizeStatus(status) {
  if (!status) return 'unknown';
  const key = String(status).toLowerCase().trim();
  return TWILIO_STATUS_MAP[key] || key.replace(/-/g, '_');
}

function getValue(payload, ...keys) {
  for (const key of keys) {
    if (payload[key] != null && payload[key] !== '') return payload[key];
  }
  return null;
}

function parseDuration(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve the canonical status from a Twilio status payload. For inbound <Dial>
 * action callbacks Twilio reports DialCallStatus for the child leg.
 */
function resolveStatus(payload) {
  const dialStatus = getValue(payload, 'DialCallStatus');
  if (dialStatus) return normalizeStatus(dialStatus);
  return normalizeStatus(getValue(payload, 'CallStatus', 'Status'));
}

/**
 * Seed (upsert) a Call record. Called from the Voice TwiML handlers when a call
 * first reaches the backend, before status webhooks arrive.
 * @param {{ callSid: string, userId?: string, direction: 'inbound'|'outbound',
 *   callerNumber?: string, receiverNumber?: string, status?: string }} params
 */
async function seedCall(params) {
  const status = normalizeStatus(params.status || 'initiated');
  const record = await Call.findOneAndUpdate(
    { callSid: params.callSid },
    {
      callSid: params.callSid,
      user: params.userId || null,
      direction: params.direction,
      mode: 'client',
      callerNumber: params.callerNumber || '',
      receiverNumber: params.receiverNumber || '',
      status,
      statusRank: rankOf(status),
      statusUpdatedAt: new Date(),
      callStartTime: new Date(),
      source: 'api',
      providerResponse: { provider: 'twilio' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  callEventLog.info('twilio.call.seeded', {
    callId: record._id?.toString(),
    callSid: record.callSid,
    direction: params.direction,
    callState: record.status,
    userId: params.userId,
  });

  await broadcastCallUpdate(record);
  return record;
}

async function findCall(callSid) {
  if (!callSid) return null;
  return Call.findOne({ callSid: String(callSid) });
}

async function generateCallReport(call) {
  if (!call || call.reportGenerated || !call.user) return null;
  const report = await CallReport.findOneAndUpdate(
    { callSid: call.callSid },
    {
      call: call._id,
      user: call.user,
      contact: call.contact || null,
      callSid: call.callSid,
      callerNumber: call.callerNumber || '',
      receiverNumber: call.receiverNumber || '',
      callDuration: call.duration || 0,
      callStatus: call.status || 'unknown',
      recordingUrl: call.recordingUrl || null,
      recordingDuration: call.recordingDuration ?? null,
      transcriptSid: call.transcriptSid || null,
      summary: call.summary || null,
      transcript: call.transcript || null,
      summaryStatus: call.summaryStatus || 'unavailable',
      callStartTime: call.callStartTime || call.createdAt,
      callEndTime: call.callEndTime || null,
      generatedAt: new Date(),
      providerResponse: call.providerResponse || {},
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  call.reportGenerated = true;
  await call.save();
  return report;
}

/**
 * Apply a Twilio call status webhook to the local Call record.
 */
async function applyCallStatusWebhook(payload) {
  const callSid = getValue(payload, 'CallSid', 'ParentCallSid');
  if (!callSid) {
    callEventLog.warn('twilio.webhook.status.missing_call_sid', {
      payloadKeys: Object.keys(payload || {}),
    });
    return null;
  }

  const record = await findCall(callSid);
  if (!record) {
    callEventLog.warn('twilio.webhook.status.unknown_call', { callSid });
    return null;
  }

  const status = resolveStatus(payload);
  const rank = rankOf(status);
  const previousStatus = record.status;
  const duration = parseDuration(getValue(payload, 'CallDuration', 'DialCallDuration', 'Duration'));
  const from = getValue(payload, 'From', 'Caller');
  const to = getValue(payload, 'To', 'Called');

  record.providerResponse = { ...(record.providerResponse || {}), ...payload, provider: 'twilio' };
  record.statusUpdatedAt = new Date();
  record.source = 'webhook';

  if (rank >= (record.statusRank ?? 0)) {
    record.status = status;
    record.statusRank = rank;
  }
  if (status === 'in_progress' && previousStatus !== 'in_progress') {
    record.recordingActive = true;
    if (!record.callStartTime) record.callStartTime = new Date();
  }
  if (from && !record.callerNumber) record.callerNumber = from;
  if (to && !record.receiverNumber) record.receiverNumber = to;
  if (duration > 0) record.duration = duration;
  if (isTerminal(status)) record.callEndTime = record.callEndTime || new Date();

  if (!record.contact && record.user) {
    const phone = record.direction === 'inbound' ? record.callerNumber : record.receiverNumber;
    const contact = await savedContactService.findContactByPhone(record.user, phone);
    if (contact) record.contact = contact._id;
  }

  await record.save();

  if (previousStatus !== record.status) {
    callEventLog.stateTransition('twilio.webhook.status.updated', previousStatus, record.status, {
      callId: record._id?.toString(),
      callSid: record.callSid,
      direction: record.direction,
      duration: record.duration,
      source: 'webhook',
    });
  }

  await broadcastCallUpdate(record);

  if (isTerminal(record.status) && !record.reportGenerated) {
    await generateCallReport(record);
  }

  return record;
}

/**
 * Apply a Twilio recording status callback.
 */
async function applyRecordingWebhook(payload) {
  const callSid = getValue(payload, 'CallSid', 'ParentCallSid');
  const recordingSid = getValue(payload, 'RecordingSid');
  if (!callSid || !recordingSid) {
    callEventLog.warn('twilio.webhook.recording.missing_fields', {
      hasCallSid: Boolean(callSid),
      hasRecordingSid: Boolean(recordingSid),
    });
    return null;
  }

  const call = await findCall(callSid);
  if (!call) {
    callEventLog.warn('twilio.webhook.recording.unknown_call', { callSid, recordingSid });
    return null;
  }

  const duration = parseDuration(getValue(payload, 'RecordingDuration', 'Duration'));
  const recordingUrl = twilioService.buildRecordingMediaUrl(getValue(payload, 'RecordingUrl'));
  const status = normalizeStatus(getValue(payload, 'RecordingStatus') || 'completed');

  call.recordingSid = String(recordingSid);
  call.recordingUrl = recordingUrl;
  call.recordingDuration = duration > 0 ? duration : call.recordingDuration;
  call.providerResponse = { ...(call.providerResponse || {}), recording: payload };
  await call.save();

  callEventLog.info('twilio.webhook.recording.saved', {
    callId: call._id?.toString(),
    callSid,
    recordingSid,
    duration,
    status,
  });

  if (call.user) {
    await CallRecording.findOneAndUpdate(
      { recordingSid: String(recordingSid) },
      {
        call: call._id,
        user: call.user,
        callSid,
        recordingSid: String(recordingSid),
        recordingUrl,
        duration,
        status,
        channels: parseDuration(getValue(payload, 'RecordingChannels')) || 1,
        raw: payload,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  await broadcastRecordingReady(call);

  if (isTerminal(call.status) && !call.reportGenerated) {
    await generateCallReport(call);
  }

  // Kick off Conversational Intelligence (AI summary + transcript) for the
  // finished recording. Fire-and-forget: failures here must not fail the
  // recording webhook, and results arrive later via the intelligence webhook.
  if (status === 'completed') {
    twilioIntelligence.requestSummary(call).catch((err) => {
      callEventLog.warn('twilio.intelligence.request_failed', {
        callSid,
        recordingSid,
        error: err?.message,
      });
    });
  }

  return call;
}

export default {
  normalizeStatus,
  resolveStatus,
  seedCall,
  applyCallStatusWebhook,
  applyRecordingWebhook,
  generateCallReport,
  findCall,
};
