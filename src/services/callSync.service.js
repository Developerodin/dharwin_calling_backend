/**
 * Plivo webhook event processing — single chokepoint for call state updates.
 */

import Call, { rankOf, isTerminal } from '../models/call.model.js';
import CallRecording from '../models/callRecording.model.js';
import CallReport from '../models/callReport.model.js';
import SipEndpoint from '../models/sipEndpoint.model.js';
import plivoService from './plivo.service.js';
import savedContactService from './savedContact.service.js';
import callEventLog from '../utils/callEventLog.js';
import { broadcastCallUpdate, emitIncomingPhoneCall } from '../socket/callBroadcast.js';

const PLIVO_STATUS_MAP = {
  queued: 'initiated',
  initiated: 'initiated',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  in_progress: 'in_progress',
  answered: 'in_progress',
  completed: 'completed',
  busy: 'busy',
  failed: 'failed',
  'no-answer': 'no_answer',
  no_answer: 'no_answer',
  canceled: 'canceled',
  cancelled: 'canceled',
  cancel: 'canceled',
  // The recipient actively declined the call — distinct from busy/no-answer.
  rejected: 'rejected',
  declined: 'rejected',
  timeout: 'no_answer',
};

// Maps Plivo SIP/Q.850 hangup causes to a canonical call outcome.
// Reference: https://www.plivo.com/docs/voice/concepts/hangup-causes
const HANGUP_CAUSE_STATUS_MAP = {
  // Recipient actively declined the call.
  CALL_REJECTED: 'rejected',
  // Recipient's line was busy.
  USER_BUSY: 'busy',
  // Recipient did not answer in time.
  NO_USER_RESPONSE: 'no_answer',
  NO_ANSWER: 'no_answer',
  ALLOTTED_TIMEOUT: 'no_answer',
  // Caller cancelled before the recipient answered.
  ORIGINATOR_CANCEL: 'canceled',
  // Call connected and ended normally.
  NORMAL_CLEARING: 'completed',
  // Network / carrier / routing failures.
  UNALLOCATED_NUMBER: 'failed',
  NO_ROUTE_DESTINATION: 'failed',
  NO_ROUTE_TRANSIT_NET: 'failed',
  NORMAL_TEMPORARY_FAILURE: 'failed',
  RECOVERY_ON_TIMER_EXPIRE: 'failed',
  NETWORK_OUT_OF_ORDER: 'failed',
  SERVICE_UNAVAILABLE: 'failed',
  DESTINATION_OUT_OF_ORDER: 'failed',
  INCOMPATIBLE_DESTINATION: 'failed',
  CHANNEL_UNACCEPTABLE: 'failed',
  PROTOCOL_ERROR: 'failed',
  INTERWORKING: 'failed',
  MANDATORY_IE_MISSING: 'failed',
};

function normalizePlivoStatus(status) {
  if (!status) return 'unknown';
  const key = String(status).toLowerCase().trim();
  return PLIVO_STATUS_MAP[key] || key.replace(/-/g, '_');
}

function parsePlivoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDuration(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function normalizePhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function phonesMatch(a, b) {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  if (!da || !db) return false;
  return da === db || da.endsWith(db) || db.endsWith(da);
}

const UNANSWERED_STATUSES = new Set(['busy', 'no_answer', 'canceled', 'failed', 'rejected']);

function getPayloadValue(payload, ...keys) {
  for (const key of keys) {
    if (payload[key] != null && payload[key] !== '') return payload[key];
  }
  return null;
}

function resolveCallUuid(payload) {
  return getPayloadValue(payload, 'CallUUID', 'call_uuid', 'CallUuid', 'ParentCallUUID', 'RequestUUID', 'request_uuid');
}

function mapHangupCause(hangupCause) {
  if (!hangupCause) return null;
  return HANGUP_CAUSE_STATUS_MAP[String(hangupCause).toUpperCase()] || null;
}

function humanizeHangupCause(hangupCause) {
  if (!hangupCause) return null;
  const key = String(hangupCause).toUpperCase();
  const messages = {
    UNALLOCATED_NUMBER:
      'The destination number could not be reached. Verify the number is valid and your Plivo account can call this destination.',
    INVALID_NUMBER_FORMAT: 'The destination phone number format is invalid.',
    NO_ROUTE_DESTINATION: 'No carrier route is available to this destination. Check your Plivo account international permissions.',
    INVALID_ACTION_XML: 'Call connected but audio setup failed. Check that Plivo webhooks can reach your server (ngrok HTTPS).',
  };
  return messages[key] || String(hangupCause).replace(/_/g, ' ');
}

// Definitive "the call never connected" outcomes. When a call was not answered,
// the carrier hangup cause is the authoritative outcome and overrides any
// generic CallStatus (e.g. Plivo reporting "completed"/"failed" for a declined call).
const DEFINITIVE_UNANSWERED = new Set(['rejected', 'busy', 'no_answer', 'canceled', 'failed']);

function refineUnansweredStatus(status, payload) {
  const duration = parseDuration(
    getPayloadValue(payload, 'Duration', 'BillDuration', 'CallDuration', 'duration', 'bill_duration')
  );
  const answerTime = parsePlivoDate(
    getPayloadValue(payload, 'AnswerTime', 'answer_time', 'StartTime')
  );
  const wasAnswered = duration > 0 || Boolean(answerTime);
  const hangupCause = getPayloadValue(
    payload,
    'HangupCause',
    'hangup_cause_name',
    'DialBLegHangupCause',
    'DialHangupCause'
  );
  const causeStatus = mapHangupCause(hangupCause);

  // A call that genuinely connected and then ended is "completed" — never
  // reclassified as rejected/busy/no-answer.
  if (wasAnswered) {
    if (status === 'completed' || causeStatus === 'completed') return 'completed';
    return status;
  }

  // Unanswered call: trust a definitive carrier cause (declined/busy/no-answer/…)
  // even when Plivo's CallStatus is a generic "completed"/"failed".
  if (causeStatus && DEFINITIVE_UNANSWERED.has(causeStatus)) {
    return causeStatus;
  }

  // No usable cause and the provider only reports a generic terminal status for a
  // call that never connected — treat it as no-answer (it was never picked up).
  if (status === 'completed' || status === 'unknown') {
    return 'no_answer';
  }

  return status;
}

function resolveStatusFromPayload(payload) {
  const dialStatus = getPayloadValue(payload, 'DialStatus', 'DialBLegStatus');
  if (dialStatus) {
    const normalized = normalizePlivoStatus(dialStatus);
    const dialHangupCause = getPayloadValue(
      payload,
      'DialBLegHangupCause',
      'DialHangupCause',
      'HangupCause',
      'hangup_cause_name'
    );
    const causeStatus = mapHangupCause(dialHangupCause);
    if (causeStatus && (normalized === 'completed' || normalized === 'failed')) {
      return refineUnansweredStatus(causeStatus, payload);
    }
    return refineUnansweredStatus(normalized, payload);
  }

  const rawStatus = getPayloadValue(payload, 'CallStatus', 'Status', 'Event');
  const hangupCause = getPayloadValue(
    payload,
    'HangupCause',
    'hangup_cause_name',
    'DialBLegHangupCause',
    'DialHangupCause'
  );
  if (rawStatus === 'Hangup' || rawStatus === 'hangup') {
    const mapped = mapHangupCause(hangupCause);
    if (mapped) {
      return refineUnansweredStatus(mapped, payload);
    }
    return refineUnansweredStatus('completed', payload);
  }

  if (!rawStatus && hangupCause) {
    const mapped = mapHangupCause(hangupCause);
    if (mapped) return refineUnansweredStatus(mapped, payload);
  }

  return refineUnansweredStatus(normalizePlivoStatus(rawStatus), payload);
}

/**
 * Resolve status from a Plivo REST Call object (parent or child leg).
 * @param {Record<string, unknown>} data
 */
function resolveStatusFromPlivoCallData(data = {}) {
  const payload = {
    CallStatus: data.call_status || data.status,
    HangupCause: data.hangup_cause_name,
    Duration: data.bill_duration ?? data.duration,
    AnswerTime: data.answer_time,
    EndTime: data.end_time,
  };
  return resolveStatusFromPayload(payload);
}

async function findCallByUuid(callUuid) {
  if (!callUuid) return null;
  const uuid = String(callUuid);

  let record = await Call.findOne({ callSid: uuid });
  if (record) return record;

  record = await Call.findOne({ 'providerResponse.plivoChildCallUuids': uuid });
  if (record) return record;

  record = await Call.findOne({ 'providerResponse.clientRegistration.previousSid': uuid });
  if (record) return record;

  record = await Call.findOne({ 'providerResponse.clientRegistration.callSid': uuid });
  return record;
}

async function findRecentPendingClientCall(receiverNumber, sipUsername) {
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const baseQuery = {
    mode: 'client',
    callSid: { $regex: '^pending_' },
    status: { $in: ['initiated', 'ringing', 'in_progress'] },
    createdAt: { $gte: since },
  };

  if (sipUsername) {
    const endpoint = await SipEndpoint.findOne({ username: sipUsername });
    if (endpoint?.user) {
      const byUser = await Call.findOne({ ...baseQuery, user: endpoint.user }).sort({ createdAt: -1 });
      if (byUser) return byUser;
    }
  }

  if (!receiverNumber) return null;

  const candidates = await Call.find({
    ...baseQuery,
    receiverNumber: { $exists: true, $ne: '' },
  })
    .sort({ createdAt: -1 })
    .limit(10);

  return candidates.find((call) => phonesMatch(call.receiverNumber, receiverNumber)) || null;
}

function trackChildCallUuid(record, childUuid) {
  if (!childUuid) return;
  const uuid = String(childUuid);
  if (record.callSid === uuid) return;

  const existing = record.providerResponse?.plivoChildCallUuids || [];
  if (existing.includes(uuid)) return;

  record.providerResponse = {
    ...(record.providerResponse || {}),
    plivoChildCallUuids: [...existing, uuid],
  };
}

async function findCallByPayload(payload) {
  const callUuid = getPayloadValue(payload, 'CallUUID', 'call_uuid', 'CallUuid');
  const parentUuid = getPayloadValue(payload, 'ParentCallUUID', 'parent_call_uuid');
  const requestUuid = getPayloadValue(payload, 'RequestUUID', 'request_uuid');
  const dharwinCallId = getPayloadValue(
    payload,
    'X-PH-DharwinCallId',
    'X-PH-Dharwin-Call-Id',
    'X-PH-dharwincallid'
  );

  const lookupIds = [callUuid, parentUuid, requestUuid].filter(Boolean);
  for (const id of lookupIds) {
    const record = await findCallByUuid(id);
    if (record) {
      if (callUuid && parentUuid && record.callSid === String(parentUuid) && callUuid !== parentUuid) {
        trackChildCallUuid(record, callUuid);
      }
      return record;
    }
  }

  if (dharwinCallId) {
    const record = await Call.findById(dharwinCallId);
    if (record) return record;
  }

  const dialTo = getPayloadValue(payload, 'DialBLegTo', 'To', 'to_number');
  const from = getPayloadValue(payload, 'From', 'from_number');
  const sipUsername = extractSipUsername(from);
  if (dialTo || sipUsername) {
    const pending = await findRecentPendingClientCall(dialTo ? String(dialTo) : '', sipUsername);
    if (pending) return pending;
  }

  return null;
}

function mergeProviderResponse(record, payload) {
  const existing = record.providerResponse || record.twilioResponse || {};
  return { ...existing, ...payload };
}

/**
 * Apply a call status webhook payload to the local Call record.
 */
async function applyCallStatusWebhook(payload) {
  const callSid = resolveCallUuid(payload);
  if (!callSid) {
    callEventLog.warn('webhook.status.missing_call_uuid', { payloadKeys: Object.keys(payload || {}) });
    return null;
  }

  const status = resolveStatusFromPayload(payload);
  const rank = rankOf(status);
  const duration = parseDuration(
    getPayloadValue(payload, 'Duration', 'BillDuration', 'CallDuration', 'duration')
  );
  const startTime = parsePlivoDate(
    getPayloadValue(payload, 'AnswerTime', 'StartTime', 'InitiationTime', 'SessionStart')
  );
  const endTime = parsePlivoDate(getPayloadValue(payload, 'EndTime', 'HangupTime'));

  const record = await findCallByPayload(payload);
  if (!record) {
    callEventLog.warn('webhook.status.unknown_call', {
      callSid,
      status,
      dialStatus: getPayloadValue(payload, 'DialStatus', 'DialBLegStatus') || undefined,
      hangupCause: getPayloadValue(payload, 'HangupCause', 'hangup_cause_name', 'DialBLegHangupCause') || undefined,
      to: getPayloadValue(payload, 'DialBLegTo', 'To', 'to_number') || undefined,
      from: getPayloadValue(payload, 'From', 'from_number') || undefined,
    });
    return null;
  }

  const previousStatus = record.status;

  const parentUuid = getPayloadValue(payload, 'ParentCallUUID', 'parent_call_uuid');
  const legUuid = getPayloadValue(payload, 'CallUUID', 'call_uuid', 'CallUuid');
  if (record.callSid.startsWith('pending_')) {
    const resolvedSid = parentUuid || legUuid;
    if (resolvedSid) {
      record.callSid = String(resolvedSid);
    }
  } else if (parentUuid && legUuid && record.callSid === String(parentUuid) && legUuid !== parentUuid) {
    trackChildCallUuid(record, legUuid);
  }

  const currentRank = record.statusRank ?? 0;
  const updates = {
    providerResponse: mergeProviderResponse(record, payload),
    statusUpdatedAt: new Date(),
    source: 'webhook',
  };

  if (rank >= currentRank) {
    updates.status = status;
    updates.statusRank = rank;
  }
  if (status === 'in_progress' && previousStatus !== 'in_progress') {
    updates.recordingActive = true;
  }
  const from = getPayloadValue(payload, 'From', 'from_number');
  const to = getPayloadValue(payload, 'To', 'to_number');
  // Preserve the canonical numbers seeded at call creation. For bridged calls
  // the leg webhooks report carrier-level numbers (e.g. the Plivo DID dialing
  // the user) that would otherwise clobber the user-facing caller/receiver.
  if (from && !record.callerNumber) updates.callerNumber = from;
  if (to && !record.receiverNumber) updates.receiverNumber = to;
  if (duration > 0) updates.duration = duration;
  if (startTime) updates.callStartTime = startTime;
  if (endTime) updates.callEndTime = endTime;

  const hangupCause = getPayloadValue(
    payload,
    'HangupCause',
    'hangup_cause_name',
    'DialBLegHangupCause',
    'DialHangupCause'
  );
  const hangupSource = getPayloadValue(payload, 'HangupSource', 'hangup_source', 'DialBLegHangupSource');
  if (hangupCause) updates.errorMessage = humanizeHangupCause(hangupCause) || String(hangupCause);

  Object.assign(record, updates);

  if (!record.contact && record.user) {
    const phone = record.direction === 'inbound' ? record.callerNumber : record.receiverNumber;
    const contact = await savedContactService.findContactByPhone(record.user, phone);
    if (contact) {
      record.contact = contact._id;
    }
  }

  await record.save();

  if (previousStatus !== record.status) {
    const context = {
      callId: record._id?.toString(),
      callSid: record.callSid,
      webhookCallSid: callSid,
      dialStatus: getPayloadValue(payload, 'DialStatus', 'DialBLegStatus') || undefined,
      duration: record.duration,
      hangupCause: hangupCause || undefined,
      hangupSource: hangupSource || undefined,
      direction: record.direction,
      source: 'webhook',
    };
    if (UNANSWERED_STATUSES.has(record.status)) {
      callEventLog.warn('webhook.status.unanswered', {
        previousState: previousStatus,
        nextState: record.status,
        callState: record.status,
        ...context,
      });
    } else {
      callEventLog.stateTransition('webhook.status.updated', previousStatus, record.status, context);
    }
  } else {
    callEventLog.debug('webhook.status.unchanged', {
      callId: record._id?.toString(),
      callSid: record.callSid,
      callState: record.status,
      webhookCallSid: callSid,
    });
  }

  // Push status to clients before report generation so terminal UI updates are not delayed.
  await broadcastCallUpdate(record);

  if (isTerminal(record.status) && !record.reportGenerated) {
    await generateCallReport(record);
  }

  return record;
}

/**
 * Apply a recording webhook payload.
 */
async function applyRecordingWebhook(payload) {
  const callSid = resolveCallUuid(payload);
  const recordingSid = getPayloadValue(payload, 'RecordingID', 'RecordingId', 'recording_id');
  if (!callSid || !recordingSid) {
    callEventLog.warn('webhook.recording.missing_fields', {
      hasCallSid: Boolean(callSid),
      hasRecordingSid: Boolean(recordingSid),
    });
    return null;
  }

  const duration = parseDuration(
    getPayloadValue(payload, 'RecordingDuration', 'RecordingDurationMs', 'duration')
  );
  const recordingUrl =
    plivoService.buildRecordingMediaUrl(
      getPayloadValue(payload, 'RecordUrl', 'RecordingUrl', 'recording_url')
    ) || null;
  const status = normalizePlivoStatus(getPayloadValue(payload, 'RecordingStatus') || 'completed');

  const call = await findCallByPayload(payload);
  if (!call) {
    callEventLog.warn('webhook.recording.unknown_call', { callSid, recordingSid });
    return null;
  }

  call.recordingSid = String(recordingSid);
  call.recordingUrl = recordingUrl;
  call.recordingDuration = duration > 0 ? duration : call.recordingDuration;
  call.providerResponse = mergeProviderResponse(call, { recording: payload });
  await call.save();

  callEventLog.info('webhook.recording.saved', {
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
        channels: parseDuration(getPayloadValue(payload, 'RecordingChannels')) || 1,
        raw: payload,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  await broadcastRecordingReady(call);

  if (isTerminal(call.status) && !call.reportGenerated) {
    await generateCallReport(call);
  }

  return call;
}

/**
 * Seed a call record when initiated via API.
 */
async function seedCall({
  callSid,
  userId,
  contactId,
  callerNumber,
  receiverNumber,
  status,
  providerResponse,
}) {
  const normalizedStatus = normalizePlivoStatus(status);
  const rank = rankOf(normalizedStatus);

  const record = await Call.findOneAndUpdate(
    { callSid },
    {
      callSid,
      user: userId,
      contact: contactId || null,
      callerNumber: callerNumber || '',
      receiverNumber: receiverNumber || '',
      direction: 'outbound',
      status: normalizedStatus,
      statusRank: rank,
      statusUpdatedAt: new Date(),
      callStartTime: new Date(),
      providerResponse: providerResponse || {},
      source: 'api',
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  callEventLog.info('call.seeded', {
    callId: record._id?.toString(),
    callSid: record.callSid,
    callState: record.status,
    userId,
    direction: 'outbound',
  });

  await broadcastCallUpdate(record);

  return record;
}

/**
 * Generate a call report from a completed call.
 */
async function generateCallReport(call) {
  if (!call || call.reportGenerated) return null;
  if (!call.user) return null;

  const providerResponse = call.providerResponse || call.twilioResponse || {};

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
      callStartTime: call.callStartTime || call.createdAt,
      callEndTime: call.callEndTime || null,
      generatedAt: new Date(),
      providerResponse,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  call.reportGenerated = true;
  await call.save();

  return report;
}

function extractSipUsername(fromValue) {
  if (!fromValue) return '';
  const raw = String(fromValue);
  const sipMatch = raw.match(/sip:([^@;>]+)/i);
  if (sipMatch?.[1]) return sipMatch[1];
  if (raw.includes('@phone.plivo.com')) {
    return raw.replace(/^sip:/i, '').split('@')[0];
  }
  return '';
}

function isPstnBridgedClientCall(record) {
  if (!record) return false;
  const providerResponse = record.providerResponse || {};
  return Boolean(providerResponse.pstnBridgedDial || providerResponse.bridgedClientDial);
}

/**
 * Resolve the call record for an inbound SDK/client answer webhook.
 * @param {{ callId?: string, callUUID?: string, parentCallUUID?: string, from?: string }} params
 */
async function resolveClientLegCallRecord(params = {}) {
  const callId = params.callId ? String(params.callId) : '';
  if (callId) {
    const byId = await Call.findById(callId);
    if (byId) return byId;
  }

  const parentCallUUID = params.parentCallUUID ? String(params.parentCallUUID) : '';
  if (parentCallUUID) {
    const byParent = await findCallByUuid(parentCallUUID);
    if (byParent) return byParent;
  }

  const callUUID = params.callUUID ? String(params.callUUID) : '';
  if (callUUID) {
    const byUuid = await findCallByUuid(callUUID);
    if (byUuid) return byUuid;
  }

  const sipUsername = extractSipUsername(params.from);
  if (sipUsername) {
    const endpoint = await SipEndpoint.findOne({ username: sipUsername });
    if (endpoint?.user) {
      const recent = await Call.findOne({
        user: endpoint.user,
        mode: 'client',
        direction: 'outbound',
        status: { $in: ['initiated', 'queued', 'ringing', 'in_progress'] },
        createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
      }).sort({ createdAt: -1 });
      if (recent) return recent;
    }
  }

  return null;
}

/**
 * Resolve PSTN destination for client SDK answer XML when Plivo omits `To`.
 * @param {{ callId?: string, from?: string, callUUID?: string }} params
 */
async function resolveClientAnswerDestination(params = {}) {
  const callId = params.callId ? String(params.callId) : '';
  if (callId) {
    const byId = await Call.findById(callId);
    if (isPstnBridgedClientCall(byId)) {
      return { receiverNumber: '', sipUsername: '', pstnBridged: true };
    }
    if (byId?.providerResponse?.receiverSipUsername) {
      return {
        sipUsername: String(byId.providerResponse.receiverSipUsername),
        receiverNumber: byId.receiverNumber || '',
      };
    }
    if (byId?.receiverNumber) {
      return { receiverNumber: byId.receiverNumber };
    }
  }

  const sipUsername = extractSipUsername(params.from);
  if (sipUsername) {
    const endpoint = await SipEndpoint.findOne({ username: sipUsername });
    if (endpoint?.user) {
      const pending = await Call.findOne({
        user: endpoint.user,
        mode: 'client',
        callSid: { $regex: '^pending_' },
        status: { $in: ['initiated', 'ringing', 'in_progress'] },
      }).sort({ createdAt: -1 });

      if (pending?.providerResponse?.receiverSipUsername) {
        return {
          sipUsername: String(pending.providerResponse.receiverSipUsername),
          receiverNumber: pending.receiverNumber || '',
        };
      }
      if (pending?.receiverNumber) {
        return { receiverNumber: pending.receiverNumber };
      }
    }
  }

  if (params.callUUID) {
    const byUuid = await findCallByUuid(String(params.callUUID));
    if (isPstnBridgedClientCall(byUuid)) {
      return { receiverNumber: '', sipUsername: '', pstnBridged: true };
    }
    if (byUuid?.providerResponse?.receiverSipUsername) {
      return {
        sipUsername: String(byUuid.providerResponse.receiverSipUsername),
        receiverNumber: byUuid.receiverNumber || '',
      };
    }
    if (byUuid?.receiverNumber) {
      return { receiverNumber: byUuid.receiverNumber };
    }
  }

  callEventLog.warn('plivo.client_answer_destination_unresolved', params);
  return { receiverNumber: '' };
}

/**
 * Bind a Plivo client-leg UUID to the pending API call record when answer XML is fetched.
 * Ensures subsequent webhooks can resolve the call before the app calls /calls/register.
 */
async function linkClientLegToCall({ callId, callUuid, from, to }) {
  if (!callUuid) return null;

  let record = null;
  if (callId) {
    record = await Call.findById(callId);
  }
  if (!record) {
    record = await findCallByUuid(callUuid);
  }
  if (!record) {
    const sipUsername = extractSipUsername(from);
    record = await findRecentPendingClientCall(to || '', sipUsername);
  }
  if (!record) return null;

  const uuid = String(callUuid);
  const wasPending = record.callSid.startsWith('pending_');

  if (wasPending || record.callSid !== uuid) {
    const previousSid = record.callSid;
    record.callSid = uuid;
    record.providerResponse = mergeProviderResponse(record, {
      clientLegLinked: true,
      previousSid: wasPending ? previousSid : record.providerResponse?.previousSid,
      answerWebhook: { callUuid: uuid, from, to },
    });
    if (record.status === 'initiated') {
      record.status = 'ringing';
      record.statusRank = Math.max(record.statusRank ?? 0, rankOf('ringing'));
    }
    record.statusUpdatedAt = new Date();
    await record.save();

    callEventLog.info('call.client_leg.linked', {
      callId: record._id?.toString(),
      callSid: uuid,
      previousCallSid: previousSid,
      callState: record.status,
    });

    await broadcastCallUpdate(record);

    const receiverUserId = record.providerResponse?.receiverUserId;
    if (receiverUserId && record.providerResponse?.appToApp) {
      await emitIncomingPhoneCall(String(receiverUserId), {
        callId: String(record._id),
        callSid: uuid,
        callUUID: uuid,
        callerNumber: record.callerNumber || '',
        receiverNumber: record.receiverNumber || '',
        status: record.status,
        direction: 'inbound',
      });
    }
  }

  return record;
}

export default {
  normalizePlivoStatus,
  resolveStatusFromPayload,
  resolveStatusFromPlivoCallData,
  applyCallStatusWebhook,
  applyRecordingWebhook,
  seedCall,
  generateCallReport,
  isPstnBridgedClientCall,
  resolveClientLegCallRecord,
  resolveClientAnswerDestination,
  linkClientLegToCall,
  findCallByUuid,
  findCallByPayload,
};
