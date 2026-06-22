import httpStatus from 'http-status';
import Call, { isTerminal, rankOf } from '../models/call.model.js';
import CallRecording from '../models/callRecording.model.js';
import CallReport from '../models/callReport.model.js';
import ApiError from '../utils/ApiError.js';
import plivoService from './plivo.service.js';
import callSyncService from './callSync.service.js';
import savedContactService from './savedContact.service.js';
import endpointService from './endpoint.service.js';
import SipEndpoint from '../models/sipEndpoint.model.js';
import { userIsAdmin } from '../utils/authHelpers.js';
import { normalizePhone } from '../utils/phone.js';
import callEventLog from '../utils/callEventLog.js';
import { broadcastCallUpdate } from '../socket/callBroadcast.js';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildUserFilter(userId, isAdmin) {
  if (isAdmin) return {};
  return { user: userId };
}

const ACTIVE_OUTBOUND_STATUSES = ['initiated', 'queued', 'ringing', 'in_progress'];
const STALE_PENDING_CLIENT_MS = 2 * 60 * 1000;

/** Serialize outbound dial initiation per user to prevent duplicate Plivo calls. */
const userDialChains = new Map();

async function withUserDialLock(userId, fn) {
  const key = String(userId);
  const previous = userDialChains.get(key) || Promise.resolve();
  let releaseNext;
  const current = new Promise((resolve) => {
    releaseNext = resolve;
  });
  userDialChains.set(
    key,
    previous.then(() => current),
  );
  await previous;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (userDialChains.get(key) === current) {
      userDialChains.delete(key);
    }
  }
}

async function cancelStalePendingClientCalls(userId) {
  const staleBefore = new Date(Date.now() - STALE_PENDING_CLIENT_MS);
  const stale = await Call.find({
    user: userId,
    direction: 'outbound',
    mode: 'client',
    callSid: { $regex: '^pending_' },
    status: { $in: ACTIVE_OUTBOUND_STATUSES },
    createdAt: { $lt: staleBefore },
  });

  if (!stale.length) return;

  const now = new Date();
  await Promise.all(
    stale.map(async (record) => {
      record.status = 'canceled';
      record.statusRank = rankOf('canceled');
      record.statusUpdatedAt = now;
      record.callEndTime = now;
      await record.save();
      await broadcastCallUpdate(record);
      callEventLog.info('call.pending.stale_canceled', {
        userId,
        callId: record._id?.toString(),
        callSid: record.callSid,
        callState: record.status,
      });
    }),
  );
}

async function findActiveOutboundCall(userId) {
  await cancelStalePendingClientCalls(userId);

  return Call.findOne({
    user: userId,
    direction: 'outbound',
    status: { $in: ACTIVE_OUTBOUND_STATUSES },
  }).sort({ createdAt: -1 });
}

function otherPartyPhone(call) {
  if (!call) return '';
  return call.direction === 'inbound' ? call.callerNumber : call.receiverNumber;
}

async function enrichCallWithContact(userId, record) {
  if (!record || record.contact || !userId) return record;

  const phone = otherPartyPhone(record);
  if (!phone) return record;

  const contact = await savedContactService.findContactByPhone(userId, phone);
  if (!contact) return record;

  record.contact = contact;
  if (record._id) {
    await Call.updateOne({ _id: record._id, contact: null }, { contact: contact._id });
  }
  return record;
}

async function enrichCallsWithContacts(userId, calls) {
  if (!userId || !calls?.length) return calls;

  const needsContact = calls.filter((call) => !call.contact);
  if (needsContact.length === 0) return calls;

  const contacts = await savedContactService.listContactsForUser(userId);
  if (!contacts.length) return calls;

  const updates = [];

  for (const call of needsContact) {
    const phone = otherPartyPhone(call);
    const matched = savedContactService.matchContactByPhone(contacts, phone);
    if (!matched) continue;

    call.contact = matched;
    if (call._id) {
      updates.push(Call.updateOne({ _id: call._id, contact: null }, { contact: matched._id }));
    }
  }

  if (updates.length) {
    await Promise.all(updates);
  }

  return calls;
}

async function makeCall(userId, body) {
  return withUserDialLock(userId, () => makeCallUnlocked(userId, body));
}

async function makeCallUnlocked(userId, body) {
  if (!plivoService.isConfigured()) {
    callEventLog.error('call.initiate.plivo_not_configured', { userId });
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Plivo is not configured on the server.');
  }

  let contactId = body.contactId || null;
  let to = body.to;

  if (contactId) {
    const contact = await savedContactService.getContactById(userId, contactId);
    to = contact.phone;
  } else if (to) {
    const contact = await savedContactService.findContactByPhone(userId, to);
    if (contact) {
      contactId = contact._id || contact.id;
    }
  }

  if (!to) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'to or contactId is required');
  }

  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid destination phone number');
  }
  to = normalizedTo;

  const existingActive = await findActiveOutboundCall(userId);
  if (existingActive) {
    callEventLog.warn('call.initiate.blocked_active_call', {
      userId,
      callId: existingActive._id?.toString(),
      callSid: existingActive.callSid,
      callState: existingActive.status,
    });
    throw new ApiError(httpStatus.CONFLICT, 'You already have an active call in progress.');
  }

  const requestedMode = String(body.mode || 'client').toLowerCase();
  const mode = ['server', 'client'].includes(requestedMode) ? requestedMode : 'server';

  callEventLog.info('call.initiate.request', {
    userId,
    mode,
    contactId,
    hasTo: Boolean(to),
  });

  if (mode === 'client') {
    await endpointService.prepareSdkOutbound(userId);

    const credentials = await endpointService.getCredentialsForUser(userId, {
      rotateCredentials: false,
      skipApplicationSync: true,
    });

    if (body.registerPhone) {
      await endpointService.updateEndpointPhone(userId, body.registerPhone);
    }

    const outboundCallerId = plivoService.resolveOutboundCallerId(to, credentials.callerId || body.from);

    const appToAppRequested = body.appToApp === true || body.appToApp === 'true';
    let receiverSipUsername = null;
    let receiverUserId = null;
    let dialTarget = to;

    if (appToAppRequested) {
      const receiverEndpoint = await endpointService.findEndpointByPhone(to);
      receiverSipUsername = receiverEndpoint?.username || null;
      receiverUserId = receiverEndpoint?.user ? String(receiverEndpoint.user) : null;
      dialTarget = receiverSipUsername ? endpointService.buildSipUri(receiverSipUsername) : to;
    }

    const pstnBridge = !receiverSipUsername;

    callEventLog.info('call.initiate.receiver_lookup', {
      userId,
      receiverNumber: to,
      appToAppRequested,
      receiverFound: Boolean(receiverSipUsername),
      pstnBridge,
    });

    const pendingCallSid = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const record = await callSyncService.seedCall({
      callSid: pendingCallSid,
      userId,
      contactId,
      callerNumber: outboundCallerId || credentials.callerId || body.from || '',
      receiverNumber: to,
      status: 'initiated',
      providerResponse: {
        mode: 'client',
        pending: true,
        dialTarget,
        receiverSipUsername,
        receiverUserId,
        appToApp: Boolean(receiverSipUsername),
        pstnBridge,
      },
    });

    record.mode = 'client';
    await record.save();

    let bridgedDial = false;
    let sdkOutbound = false;

    const registration = await endpointService.waitForEndpointRegistered(userId, 5_000);
    if (!registration.registered) {
      record.status = 'failed';
      record.statusRank = rankOf('failed');
      record.statusUpdatedAt = new Date();
      record.errorMessage = 'SIP endpoint not registered';
      record.providerResponse = {
        ...(record.providerResponse || {}),
        sipRegistrationError: registration.error || 'Endpoint not registered on Plivo',
      };
      await record.save();
      await broadcastCallUpdate(record);
      callEventLog.error('call.initiate.sip_not_registered', {
        userId,
        callId: record._id?.toString(),
        username: registration.username,
      });
      throw new ApiError(
        httpStatus.BAD_GATEWAY,
        'Plivo SIP endpoint is not registered. Check network connectivity and try again.',
      );
    }

    if (pstnBridge) {
      const lookup = await plivoService.lookupPhoneNumber(to);
      if (!lookup.success) {
        record.status = 'failed';
        record.statusRank = rankOf('failed');
        record.statusUpdatedAt = new Date();
        record.errorMessage = lookup.error || 'Destination number lookup failed';
        record.providerResponse = {
          ...(record.providerResponse || {}),
          lookupError: lookup.error,
        };
        await record.save();
        await broadcastCallUpdate(record);
        callEventLog.error('call.initiate.lookup_failed', {
          userId,
          callId: record._id?.toString(),
          receiverNumber: to,
        }, lookup.error);
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          lookup.error || 'Destination phone number could not be verified. Check the number and try again.',
        );
      }

      callEventLog.info('call.initiate.lookup_ok', {
        userId,
        callId: record._id?.toString(),
        receiverNumber: lookup.e164,
        carrier: lookup.carrierName || '(unknown)',
        carrierType: lookup.carrierType || '(unknown)',
      });

      record.callerNumber = outboundCallerId || record.callerNumber;

      // PSTN client calls use a server-initiated dial that bridges to the app's
      // registered SIP endpoint on answer. Voice stays on the Plivo Browser SDK;
      // direct client.call() outbound is unreliable on React Native WebRTC.
      const bridgeResult = await plivoService.initiateBridgedClientCall({
        to,
        callId: record._id.toString(),
        from: outboundCallerId,
      });

      if (!bridgeResult.success) {
        record.status = 'failed';
        record.statusRank = rankOf('failed');
        record.statusUpdatedAt = new Date();
        record.errorMessage = bridgeResult.error || 'Failed to dial destination';
        record.providerResponse = {
          ...(record.providerResponse || {}),
          bridgedClientDialError: bridgeResult.error,
        };
        await record.save();
        await broadcastCallUpdate(record);
        callEventLog.error('call.initiate.bridged_pstn_dial_failed', {
          userId,
          callId: record._id?.toString(),
          receiverNumber: to,
        }, bridgeResult.error);
        throw new ApiError(httpStatus.BAD_GATEWAY, bridgeResult.error || 'Failed to dial destination');
      }

      const normalizedStatus = callSyncService.normalizePlivoStatus(bridgeResult.status);
      record.callSid = bridgeResult.callSid;
      record.callerNumber = bridgeResult.callerNumber || record.callerNumber;
      record.receiverNumber = bridgeResult.receiverNumber || record.receiverNumber;
      record.status = normalizedStatus;
      record.statusRank = rankOf(normalizedStatus);
      record.statusUpdatedAt = new Date();
      record.providerResponse = {
        ...(record.providerResponse || {}),
        pending: false,
        bridgedClientDial: true,
        pstnBridgedDial: true,
        sdkWebRtc: true,
        outboundCallerId,
        agentSipUsername: credentials.username,
        serverDial: bridgeResult.providerResponse,
      };
      await record.save();
      await broadcastCallUpdate(record);
      bridgedDial = true;

      callEventLog.info('call.initiate.bridged_pstn_dial_started', {
        userId,
        callId: record._id?.toString(),
        callSid: record.callSid,
        callState: record.status,
        receiverNumber: to,
        outboundCallerId,
      });
    } else {
      const bridgeResult = await plivoService.initiateBridgedClientCall({
        sipUsername: receiverSipUsername,
        callId: record._id.toString(),
        from: outboundCallerId,
      });

      if (!bridgeResult.success) {
        record.status = 'failed';
        record.statusRank = rankOf('failed');
        record.statusUpdatedAt = new Date();
        record.providerResponse = {
          ...(record.providerResponse || {}),
          bridgedClientDialError: bridgeResult.error,
        };
        await record.save();
        await broadcastCallUpdate(record);
        callEventLog.error('call.initiate.bridged_dial_failed', {
          userId,
          callId: record._id?.toString(),
          receiverNumber: to,
          appToApp: true,
        }, bridgeResult.error);
        throw new ApiError(httpStatus.BAD_GATEWAY, bridgeResult.error || 'Failed to dial destination');
      }

      const normalizedStatus = callSyncService.normalizePlivoStatus(bridgeResult.status);
      record.callSid = bridgeResult.callSid;
      record.callerNumber = bridgeResult.callerNumber || record.callerNumber;
      record.receiverNumber = bridgeResult.receiverNumber || record.receiverNumber;
      record.status = normalizedStatus;
      record.statusRank = rankOf(normalizedStatus);
      record.statusUpdatedAt = new Date();
      record.providerResponse = {
        ...(record.providerResponse || {}),
        pending: false,
        bridgedClientDial: true,
        appToAppBridgedDial: true,
        agentSipUsername: credentials.username,
        serverDial: bridgeResult.providerResponse,
      };
      await record.save();
      await broadcastCallUpdate(record);
      bridgedDial = true;

      callEventLog.info('call.initiate.bridged_dial_started', {
        userId,
        callId: record._id?.toString(),
        callSid: record.callSid,
        callState: record.status,
        appToApp: true,
      });
    }

    callEventLog.info('call.initiate.client_session_created', {
      userId,
      callId: record._id?.toString(),
      callSid: record.callSid,
      callState: record.status,
      mode: 'client',
      direction: 'outbound',
      appToApp: Boolean(receiverSipUsername),
      bridgedDial,
      sdkOutbound,
    });

    return {
      call: record,
      credentials: {
        ...credentials,
        callerId: outboundCallerId || credentials.callerId,
      },
      clientMode: true,
      dialTarget,
      bridgedDial,
      sdkOutbound,
      sdkWebRtc: true,
    };
  }

  const result = await plivoService.initiateCall({ to, from: body.from });
  if (!result.success) {
    callEventLog.error('call.initiate.plivo_failed', {
      userId,
      mode: 'server',
      receiverNumber: to,
    }, result.error);
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to initiate call');
  }

  const record = await callSyncService.seedCall({
    callSid: result.callSid,
    userId,
    contactId,
    callerNumber: result.callerNumber,
    receiverNumber: result.receiverNumber,
    status: result.status,
    providerResponse: result.providerResponse,
  });

  record.mode = 'server';
  await record.save();

  callEventLog.info('call.initiate.server_dial_started', {
    userId,
    callId: record._id?.toString(),
    callSid: record.callSid,
    callState: record.status,
    mode: 'server',
    direction: 'outbound',
  });

  return { call: record, clientMode: false };
}

/**
 * Fall back when the SDK outbound leg fails. For client-mode calls the fallback
 * uses a REST PSTN dial that bridges to the app's SIP endpoint on answer so
 * two-way audio still flows through the Browser SDK.
 */
async function dialServerLeg(userId, callId, isAdmin, options = {}) {
  const { force = false, bridged = true } = options;
  callEventLog.info('call.server_dial.request', { userId, callId, force, bridged });

  const filter = { _id: callId, ...buildUserFilter(userId, isAdmin) };
  const record = await Call.findOne(filter);
  if (!record) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  }

  if (!record.receiverNumber) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Call has no receiver number');
  }

  if (!force && record.callSid?.startsWith('pending_')) {
    const ageMs = Date.now() - new Date(record.createdAt).getTime();
    const pendingGraceMs = 45_000;
    if (ageMs < pendingGraceMs) {
      callEventLog.info('call.server_dial.skipped_pending_grace', {
        userId,
        callId,
        callSid: record.callSid,
        ageMs,
      });
      return enrichCallWithContact(userId, record);
    }
  }

  if (record.callSid && !record.callSid.startsWith('pending_')) {
    const children = await plivoService.listCallsByParent(record.callSid);
    const receiverDigits = String(record.receiverNumber).replace(/\D/g, '');
    const hasActivePstnChild =
      children.success &&
      children.calls?.some((child) => {
        const childTo = String(child.to_number || child.to || '').replace(/\D/g, '');
        if (!childTo || !receiverDigits || !childTo.endsWith(receiverDigits)) return false;
        const childStatus = callSyncService.resolveStatusFromPlivoCallData(child);
        return !isTerminal(childStatus) || childStatus === 'initiated' || childStatus === 'ringing';
      });

    if (hasActivePstnChild) {
      return enrichCallWithContact(userId, record);
    }

    const live = await plivoService.fetchCall(record.callSid);
    if (live.success && live.data) {
      const liveStatus = callSyncService.resolveStatusFromPlivoCallData(live.data);
      if (liveStatus === 'in_progress') {
        return enrichCallWithContact(userId, record);
      }
    }

    await plivoService.endCall(record.callSid).catch(() => {});
  }

  const useBridgedDial = bridged && record.mode === 'client';
  const receiverSipUsername = record.providerResponse?.receiverSipUsername || null;
  const outboundCallerId = plivoService.resolveOutboundCallerId(
    record.receiverNumber,
    record.callerNumber,
  );
  const result = useBridgedDial
    ? await plivoService.initiateBridgedClientCall({
        to: receiverSipUsername ? undefined : record.receiverNumber,
        sipUsername: receiverSipUsername || undefined,
        callId: record._id.toString(),
        from: outboundCallerId,
      })
    : await plivoService.initiateCall({ to: record.receiverNumber, from: outboundCallerId });

  if (!result.success) {
    callEventLog.error('call.server_dial.plivo_failed', {
      userId,
      callId,
      callSid: record.callSid,
      bridged: useBridgedDial,
    }, result.error);
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to dial PSTN');
  }

  const normalizedStatus = callSyncService.normalizePlivoStatus(result.status);
  const previousStatus = record.status;
  record.callSid = result.callSid;
  record.mode = useBridgedDial ? 'client' : 'server';
  record.callerNumber = result.callerNumber || record.callerNumber;
  record.receiverNumber = result.receiverNumber || record.receiverNumber;
  record.status = normalizedStatus;
  record.statusRank = rankOf(normalizedStatus);
  record.statusUpdatedAt = new Date();
  record.providerResponse = {
    ...(record.providerResponse || {}),
    serverFallbackDial: true,
    ...(useBridgedDial
      ? {
          bridgedClientDial: true,
          bridgedFallback: true,
          sdkWebRtc: true,
        }
      : {}),
    serverDial: result.providerResponse,
  };
  await record.save();

  callEventLog.stateTransition('call.server_dial.success', previousStatus, normalizedStatus, {
    userId,
    callId: record._id?.toString(),
    callSid: record.callSid,
    mode: record.mode,
    bridged: useBridgedDial,
  });

  await broadcastCallUpdate(record);

  return enrichCallWithContact(userId, record);
}

function extractSipUsernameFromPlivoFrom(fromValue) {
  if (!fromValue) return '';
  const raw = String(fromValue);
  const sipMatch = raw.match(/sip:([^@;>]+)/i);
  if (sipMatch?.[1]) return sipMatch[1];
  if (raw.includes('@phone.plivo.com')) {
    return raw.replace(/^sip:/i, '').split('@')[0];
  }
  return '';
}

async function verifyPlivoCallSidForUser(userId, callSid) {
  if (!callSid || callSid.startsWith('pending_')) return;

  const endpoint = await SipEndpoint.findOne({ user: userId });
  if (!endpoint?.username) {
    throw new ApiError(httpStatus.BAD_GATEWAY, 'SIP endpoint is not configured for this user.');
  }

  const live = await plivoService.fetchCall(callSid);
  if (!live.success || !live.data) {
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      live.error || 'Unable to verify call UUID with Plivo.',
    );
  }

  const fromUsername = extractSipUsernameFromPlivoFrom(live.data.from_number || live.data.from);
  if (fromUsername && fromUsername !== endpoint.username) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Call UUID does not belong to your Plivo session.');
  }
}

async function collectHangupLegUuids(record) {
  const uuids = new Set();
  const primarySid = record?.callSid;
  if (primarySid && !primarySid.startsWith('pending_')) {
    uuids.add(String(primarySid));
  }

  const storedChildren = record?.providerResponse?.plivoChildCallUuids || [];
  storedChildren.forEach((uuid) => {
    if (uuid) uuids.add(String(uuid));
  });

  if (primarySid && !primarySid.startsWith('pending_')) {
    const children = await plivoService.listCallsByParent(primarySid);
    if (children.success && children.calls?.length) {
      children.calls.forEach((child) => {
        const uuid = child.call_uuid || child.callUuid;
        if (uuid) uuids.add(String(uuid));
      });
    }
  }

  return [...uuids];
}

async function registerClientCall(userId, body, isAdmin) {
  const { callId, callSid } = body;
  if (!callId || !callSid) {
    callEventLog.warn('call.register_client.missing_fields', { userId, callId, callSid });
    throw new ApiError(httpStatus.BAD_REQUEST, 'callId and callSid are required');
  }

  callEventLog.info('call.register_client.request', { userId, callId, callSid });

  const filter = { _id: callId, ...buildUserFilter(userId, isAdmin) };
  const record = await Call.findOne(filter);
  if (!record) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  }

  const bridgedClientDial = Boolean(record.providerResponse?.bridgedClientDial);
  if (!bridgedClientDial) {
    await verifyPlivoCallSidForUser(userId, callSid);
  }

  const previousSid = record.callSid;
  const previousStatus = record.status;
  const bridgeSid = String(callSid);

  if (bridgedClientDial) {
    const existingChildUuids = record.providerResponse?.plivoChildCallUuids || [];
    const childUuids = existingChildUuids.includes(bridgeSid)
      ? existingChildUuids
      : [...existingChildUuids, bridgeSid];

    record.providerResponse = {
      ...(record.providerResponse || {}),
      plivoChildCallUuids: childUuids,
      bridgeLegSid: bridgeSid,
      clientRegistration: {
        ...(record.providerResponse?.clientRegistration || {}),
        bridgeLegSid: bridgeSid,
        parentSid: previousSid,
      },
    };

    if (record.status === 'initiated') {
      record.status = 'ringing';
      record.statusRank = Math.max(record.statusRank ?? 0, rankOf('ringing'));
    }
    record.statusUpdatedAt = new Date();
    await record.save();

    callEventLog.info('call.register_bridge_leg.success', {
      userId,
      callId: record._id?.toString(),
      parentCallSid: previousSid,
      bridgeLegSid: bridgeSid,
      callState: record.status,
    });

    await broadcastCallUpdate(record);
    return enrichCallWithContact(userId, record);
  }

  record.callSid = bridgeSid;
  record.mode = 'client';
  record.status = record.status === 'initiated' ? 'ringing' : record.status;
  record.statusRank = Math.max(record.statusRank ?? 0, 2);
  record.providerResponse = {
    ...(record.providerResponse || {}),
    clientRegistration: { previousSid, callSid },
  };
  await record.save();

  await syncCallFromPlivo(record, callSid);

  const refreshed = await Call.findById(record._id);
  const finalRecord = refreshed || record;

  callEventLog.stateTransition('call.register_client.success', previousStatus, finalRecord.status, {
    userId,
    callId: finalRecord._id?.toString(),
    callSid: finalRecord.callSid,
    previousCallSid: previousSid,
    mode: 'client',
  });

  return finalRecord;
}

async function syncCallFromPlivo(record, plivoSid) {
  const sid = plivoSid || record.callSid;
  if (!sid || sid.startsWith('pending_')) {
    return record;
  }

  const live = await plivoService.fetchCall(sid);
  if (live.success && live.data) {
    const parentStatus = callSyncService.resolveStatusFromPlivoCallData(live.data);
    await callSyncService.applyCallStatusWebhook({
      CallUUID: sid,
      CallStatus: live.data.call_status || live.data.status,
      Duration: live.data.bill_duration || live.data.duration,
      AnswerTime: live.data.answer_time,
      EndTime: live.data.end_time,
      From: live.data.from_number,
      To: live.data.to_number,
      HangupCause: live.data.hangup_cause_name,
    });
    const refreshed = await Call.findById(record._id);
    if (refreshed) record = refreshed;

    if (!isTerminal(record.status) && isTerminal(parentStatus)) {
      record.status = parentStatus;
      record.statusRank = rankOf(parentStatus);
      record.statusUpdatedAt = new Date();
      await record.save();
    }
  }

  const children = await plivoService.listCallsByParent(sid);
  if (children.success && children.calls?.length) {
    let bestChild = null;
    let bestRank = record.statusRank ?? 0;

    for (const child of children.calls) {
      const childStatus = callSyncService.resolveStatusFromPlivoCallData(child);
      const childRank = rankOf(childStatus);
      if (childRank > bestRank || (childRank === bestRank && isTerminal(childStatus) && !isTerminal(record.status))) {
        bestChild = child;
        bestRank = childRank;
      }
    }

    if (bestChild && bestRank >= (record.statusRank ?? 0)) {
      await callSyncService.applyCallStatusWebhook({
        CallUUID: bestChild.call_uuid || bestChild.callUuid,
        ParentCallUUID: sid,
        CallStatus: bestChild.call_status || bestChild.status,
        Duration: bestChild.bill_duration || bestChild.duration,
        AnswerTime: bestChild.answer_time,
        EndTime: bestChild.end_time,
        From: bestChild.from_number,
        To: bestChild.to_number,
        HangupCause: bestChild.hangup_cause_name,
        DialStatus: bestChild.call_status || bestChild.status,
        DialBLegHangupCause: bestChild.hangup_cause_name,
      });
      const refreshed = await Call.findById(record._id);
      if (refreshed) record = refreshed;
    }
  }

  return record;
}

async function getCallStatus(userId, id, options = {}, isAdmin = false) {
  let record = await getCallById(userId, id, isAdmin);

  if (options.sync) {
    const plivoSid =
      options.plivoSid && !String(options.plivoSid).startsWith('pending_')
        ? String(options.plivoSid)
        : record.callSid && !record.callSid.startsWith('pending_')
          ? record.callSid
          : null;

    if (plivoSid) {
      record = await syncCallFromPlivo(record, plivoSid);
      return getCallById(userId, id, isAdmin);
    }
  }

  return enrichCallWithContact(userId, record);
}

async function endCall(userId, callSid, isAdmin) {
  callEventLog.info('call.end.request', { userId, callSid });

  const filter = { callSid, ...buildUserFilter(userId, isAdmin) };
  let record = await Call.findOne(filter);
  if (!record) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  }

  if (callSid.startsWith('pending_')) {
    record.status = 'canceled';
    record.statusRank = 10;
    record.statusUpdatedAt = new Date();
    record.callEndTime = new Date();
    await record.save();
    callEventLog.info('call.end.pending_canceled', {
      userId,
      callId: record._id?.toString(),
      callSid,
      callState: record.status,
    });
    await broadcastCallUpdate(record);
    return record;
  }

  const legUuids = await collectHangupLegUuids(record);
  const hangupResults = await Promise.all(
    legUuids.map((uuid) => plivoService.endCall(uuid)),
  );

  const allNotFound = hangupResults.length > 0 && hangupResults.every((result) => {
    if (result.success) return false;
    return (
      result.status === 404 ||
      String(result.error || '')
        .toLowerCase()
        .includes('not found')
    );
  });

  if (allNotFound) {
    record = await syncCallFromPlivo(record, callSid);
    if (!isTerminal(record.status)) {
      record.status = 'completed';
      record.statusRank = 10;
      record.statusUpdatedAt = new Date();
      record.callEndTime = new Date();
      await record.save();
    }
    await broadcastCallUpdate(record);
    if (isTerminal(record.status) && !record.reportGenerated) {
      await callSyncService.generateCallReport(record);
    }
    return record;
  }

  const hardFailure = hangupResults.find(
    (result) =>
      !result.success &&
      result.status !== 404 &&
      !String(result.error || '')
        .toLowerCase()
        .includes('not found'),
  );
  if (hardFailure) {
    callEventLog.error('call.end.plivo_failed', {
      userId,
      callId: record._id?.toString(),
      callSid,
    }, hardFailure.error);
    throw new ApiError(httpStatus.BAD_GATEWAY, hardFailure.error || 'Failed to end call');
  }

  record = await syncCallFromPlivo(record, callSid);
  const refreshed = await Call.findById(record._id);
  if (refreshed) record = refreshed;

  callEventLog.info('call.end.success', {
    userId,
    callId: record._id?.toString(),
    callSid,
    callState: record.status,
    legCount: legUuids.length,
  });

  await broadcastCallUpdate(record);

  if (isTerminal(record.status) && !record.reportGenerated) {
    await callSyncService.generateCallReport(record);
  }

  return record;
}

/**
 * Update the mute state for an active call. The mute flag is kept on the call
 * record as the single source of truth and broadcast to all of the user's
 * connected clients so the control stays in sync across devices/sessions.
 */
async function setCallMuted(userId, id, muted, isAdmin) {
  const filter = { ...buildUserFilter(userId, isAdmin), $or: [{ _id: id }, { callSid: id }] };
  const record = await Call.findOne(filter);
  if (!record) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  }
  if (record.status !== 'in_progress') {
    throw new ApiError(httpStatus.CONFLICT, 'Mute can only be changed while the call is connected.');
  }

  record.muted = Boolean(muted);
  record.statusUpdatedAt = new Date();
  await record.save();

  callEventLog.info('call.mute.updated', {
    userId,
    callId: record._id?.toString(),
    callSid: record.callSid,
    muted: record.muted,
  });

  await broadcastCallUpdate(record);

  return enrichCallWithContact(userId, record);
}

/**
 * Start or stop call recording for an in-progress call.
 */
async function setCallRecording(userId, id, recording, isAdmin) {
  const filter = { ...buildUserFilter(userId, isAdmin), $or: [{ _id: id }, { callSid: id }] };
  const record = await Call.findOne(filter);
  if (!record) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  }
  if (record.status !== 'in_progress') {
    throw new ApiError(httpStatus.CONFLICT, 'Recording can only be changed while the call is connected.');
  }
  if (!record.callSid || record.callSid.startsWith('pending_')) {
    throw new ApiError(httpStatus.CONFLICT, 'Call is not linked to Plivo yet.');
  }

  const shouldRecord = Boolean(recording);
  const plivoResult = shouldRecord
    ? await plivoService.startCallRecording(record.callSid)
    : await plivoService.stopCallRecording(record.callSid);

  if (!plivoResult.success) {
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      plivoResult.error || `Failed to ${shouldRecord ? 'start' : 'stop'} recording`,
    );
  }

  record.recordingActive = shouldRecord;
  record.statusUpdatedAt = new Date();
  record.providerResponse = {
    ...(record.providerResponse || {}),
    recordingControl: plivoResult.providerResponse,
  };
  await record.save();

  callEventLog.info('call.recording.updated', {
    userId,
    callId: record._id?.toString(),
    callSid: record.callSid,
    recordingActive: record.recordingActive,
  });

  await broadcastCallUpdate(record);

  return enrichCallWithContact(userId, record);
}

async function getCallById(userId, id, isAdmin) {
  const filter = buildUserFilter(userId, isAdmin);
  // Only match by _id when the param is a valid ObjectId — otherwise Mongoose
  // throws "Cast to ObjectId failed" before it can try the callSid branch (the
  // app may look up by a Twilio CallSid "CA…" or a transient "pending_…" id).
  const or = [{ callSid: id }];
  if (/^[a-f0-9]{24}$/i.test(String(id))) or.unshift({ _id: id });
  const record = await Call.findOne({ ...filter, $or: or }).populate(
    'contact',
    'name phone secondaryPhone'
  );
  if (!record) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  }
  return enrichCallWithContact(userId, record);
}

async function listCallHistory(userId, options = {}, isAdmin = false) {
  const filter = buildUserFilter(userId, isAdmin);

  if (options.status) {
    filter.status = String(options.status).toLowerCase();
  }
  if (options.contactId) {
    filter.contact = options.contactId;
  }
  if (options.search) {
    const regex = new RegExp(escapeRegex(options.search), 'i');
    filter.$or = [{ callerNumber: regex }, { receiverNumber: regex }, { callSid: regex }];
  }
  if (options.fromDate || options.toDate) {
    filter.createdAt = {};
    if (options.fromDate) filter.createdAt.$gte = new Date(options.fromDate);
    if (options.toDate) filter.createdAt.$lte = new Date(options.toDate);
  }

  const page = Number(options.page) || 1;
  const limit = Math.min(Number(options.limit) || 25, 500);
  const sortBy = options.order === 'asc' ? 'createdAt:asc' : 'createdAt:desc';

  const data = await Call.paginate(filter, {
    page,
    limit,
    sortBy,
    populate: 'contact',
  });

  await enrichCallsWithContacts(userId, data.results);

  return {
    results: data.results,
    page: data.page,
    limit: data.limit,
    total: data.totalResults,
    totalPages: data.totalPages,
  };
}

async function listRecordings(userId, options = {}, isAdmin = false) {
  const filter = buildUserFilter(userId, isAdmin);

  if (options.callSid) filter.callSid = options.callSid;
  if (options.status) filter.status = options.status;

  const page = Number(options.page) || 1;
  const limit = Math.min(Number(options.limit) || 25, 500);

  const data = await CallRecording.paginate(filter, {
    page,
    limit,
    sortBy: 'createdAt:desc',
    populate: 'call',
  });

  return {
    results: data.results,
    page: data.page,
    limit: data.limit,
    total: data.totalResults,
    totalPages: data.totalPages,
  };
}

async function getRecordingById(userId, id, isAdmin) {
  const filter = buildUserFilter(userId, isAdmin);
  const recording = await CallRecording.findOne({
    ...filter,
    $or: [{ _id: id }, { recordingSid: id }],
  }).populate('call');

  if (!recording) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Recording not found');
  }
  return recording;
}

async function listReports(userId, options = {}, isAdmin = false) {
  const filter = buildUserFilter(userId, isAdmin);

  if (options.status) filter.callStatus = String(options.status).toLowerCase();
  if (options.contactId) filter.contact = options.contactId;
  if (options.fromDate || options.toDate) {
    filter.generatedAt = {};
    if (options.fromDate) filter.generatedAt.$gte = new Date(options.fromDate);
    if (options.toDate) filter.generatedAt.$lte = new Date(options.toDate);
  }
  if (options.search) {
    const regex = new RegExp(escapeRegex(options.search), 'i');
    filter.$or = [{ callerNumber: regex }, { receiverNumber: regex }, { callSid: regex }];
  }

  const page = Number(options.page) || 1;
  const limit = Math.min(Number(options.limit) || 25, 500);

  const data = await CallReport.paginate(filter, {
    page,
    limit,
    sortBy: 'generatedAt:desc',
    populate: 'contact',
  });

  return {
    results: data.results,
    page: data.page,
    limit: data.limit,
    total: data.totalResults,
    totalPages: data.totalPages,
  };
}

function reportsToCsv(reports) {
  const header = [
    'Call ID',
    'Caller Number',
    'Receiver Number',
    'Call Duration (s)',
    'Call Status',
    'Recording URL',
    'Recording Duration (s)',
    'Call Start Time',
    'Call End Time',
  ].join(',');

  const rows = reports.map((r) => {
    const values = [
      r.callSid,
      r.callerNumber,
      r.receiverNumber,
      r.callDuration,
      r.callStatus,
      r.recordingUrl || '',
      r.recordingDuration ?? '',
      r.callStartTime ? new Date(r.callStartTime).toISOString() : '',
      r.callEndTime ? new Date(r.callEndTime).toISOString() : '',
    ];
    return values.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  });

  return [header, ...rows].join('\n');
}

async function exportReports(userId, options = {}, isAdmin = false) {
  const { results } = await listReports(userId, { ...options, limit: 5000, page: 1 }, isAdmin);
  return reportsToCsv(results);
}

export default {
  makeCall,
  registerClientCall,
  dialServerLeg,
  setCallMuted,
  setCallRecording,
  endCall,
  getCallById,
  getCallStatus,
  listCallHistory,
  listRecordings,
  getRecordingById,
  listReports,
  exportReports,
  reportsToCsv,
};
