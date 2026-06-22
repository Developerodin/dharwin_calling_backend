/**
 * Serialises Call records and broadcasts them over Socket.IO so connected
 * clients stay in sync with the backend (the single source of truth) without
 * polling.
 *
 * Flow: Plivo webhook → DB update → emit call-status-updated (+ history/recording).
 */

import { emitToUser, emitToCallRoom, cleanupCallRoom, CALL_EVENTS } from './realtime.js';
import { isTerminal } from '../models/call.model.js';
import logger from '../config/logger.js';

/**
 * Convert a Call mongoose document into the plain shape the app expects.
 * Mirrors the REST `mapCall` consumer in the mobile app.
 * @param {import('mongoose').Document} record
 */
export function serializeCall(record) {
  if (!record) return null;
  const json = typeof record.toJSON === 'function' ? record.toJSON() : record;

  let contact = null;
  if (json.contact && typeof json.contact === 'object') {
    contact = {
      id: String(json.contact.id ?? json.contact._id ?? ''),
      name: json.contact.name,
      phone: json.contact.phone,
    };
  }

  return {
    id: String(json.id ?? record._id ?? ''),
    callSid: json.callSid ?? '',
    callerNumber: json.callerNumber ?? '',
    receiverNumber: json.receiverNumber ?? '',
    status: json.status ?? 'unknown',
    direction: json.direction ?? 'outbound',
    mode: json.mode,
    muted: Boolean(json.muted),
    recordingActive: Boolean(json.recordingActive),
    duration: typeof json.duration === 'number' ? json.duration : undefined,
    callStartTime: json.callStartTime ?? undefined,
    callEndTime: json.callEndTime ?? undefined,
    recordingUrl: json.recordingUrl ?? undefined,
    recordingDuration:
      typeof json.recordingDuration === 'number' ? json.recordingDuration : undefined,
    recordingSid: json.recordingSid ?? undefined,
    errorMessage: json.errorMessage ?? undefined,
    contact: contact ?? undefined,
    createdAt: record.createdAt ? new Date(record.createdAt).toISOString() : undefined,
  };
}

/**
 * Build the canonical real-time status payload (matches mobile contract).
 * @param {import('mongoose').Document} record
 */
export function buildStatusPayload(record) {
  const snapshot = serializeCall(record);
  if (!snapshot) return null;

  const updatedAt = record.statusUpdatedAt
    ? new Date(record.statusUpdatedAt).toISOString()
    : new Date().toISOString();

  return {
    callUUID: snapshot.callSid,
    callId: snapshot.id,
    status: snapshot.status,
    duration: snapshot.duration ?? 0,
    hangupCause: snapshot.errorMessage ?? null,
    recordingUrl: snapshot.recordingUrl ?? null,
    updatedAt,
    ...snapshot,
  };
}

/**
 * Build a compact history patch payload.
 * @param {import('mongoose').Document} record
 */
export function buildHistoryPayload(record) {
  const snapshot = serializeCall(record);
  if (!snapshot) return null;
  return {
    callUUID: snapshot.callSid,
    callId: snapshot.id,
    status: snapshot.status,
    duration: snapshot.duration ?? 0,
    receiverNumber: snapshot.receiverNumber,
    callerNumber: snapshot.callerNumber,
    direction: snapshot.direction,
    updatedAt: record.statusUpdatedAt
      ? new Date(record.statusUpdatedAt).toISOString()
      : new Date().toISOString(),
    ...snapshot,
  };
}

/**
 * Broadcast the current state of a call to its owning user and call room.
 * @param {import('mongoose').Document} record
 * @param {{ recordingOnly?: boolean }} [options]
 */
export async function broadcastCallUpdate(record, options = {}) {
  try {
    if (!record) return;

    const userId = record.user ? String(record.user) : null;
    const callUuid = record.callSid ? String(record.callSid) : null;
    const statusPayload = buildStatusPayload(record);
    const historyPayload = buildHistoryPayload(record);

    if (!statusPayload) return;

    logger.info('[Socket] broadcasting call update', {
      callUUID: callUuid,
      callId: statusPayload.callId,
      status: statusPayload.status,
      userId,
      source: options.recordingOnly ? 'recording' : 'status',
    });

    const emissions = [];

    if (userId) {
      emissions.push(emitToUser(userId, CALL_EVENTS.statusUpdated, statusPayload));
      emissions.push(emitToUser(userId, CALL_EVENTS.update, statusPayload));
      if (historyPayload) {
        emissions.push(emitToUser(userId, CALL_EVENTS.historyUpdated, historyPayload));
      }
    }

    if (callUuid) {
      emissions.push(emitToCallRoom(callUuid, CALL_EVENTS.statusUpdated, statusPayload));
      emissions.push(emitToCallRoom(callUuid, CALL_EVENTS.update, statusPayload));
    }

    if (isTerminal(statusPayload.status)) {
      if (userId) {
        emissions.push(emitToUser(userId, CALL_EVENTS.ended, statusPayload));
      }
      if (callUuid) {
        cleanupCallRoom(callUuid);
      }
    }

    await Promise.all(emissions);
  } catch (error) {
    logger.warn(`[Socket] broadcastCallUpdate failed: ${error.message}`);
  }
}

/**
 * Notify subscribers that a recording is ready for a call.
 * @param {import('mongoose').Document} record
 */
export async function broadcastRecordingReady(record) {
  try {
    if (!record?.callSid) return;

    const userId = record.user ? String(record.user) : null;
    const callUuid = String(record.callSid);
    const snapshot = serializeCall(record);
    if (!snapshot) return;

    const payload = {
      callUUID: callUuid,
      callId: snapshot.id,
      recordingUrl: snapshot.recordingUrl ?? null,
      recordingDuration: snapshot.recordingDuration ?? null,
      recordingSid: snapshot.recordingSid ?? null,
      status: snapshot.status,
      updatedAt: new Date().toISOString(),
      ...snapshot,
    };

    logger.info('[Socket] broadcasting recording-ready', {
      callUUID: callUuid,
      recordingUrl: payload.recordingUrl,
      userId,
    });

    const emissions = [
      emitToCallRoom(callUuid, CALL_EVENTS.recordingReady, payload),
      emitToUser(userId, CALL_EVENTS.recordingReady, payload),
      broadcastCallUpdate(record, { recordingOnly: true }),
    ];

    await Promise.all(emissions);
  } catch (error) {
    logger.warn(`[Socket] broadcastRecordingReady failed: ${error.message}`);
  }
}

/**
 * Notify a registered app user that an incoming Browser SDK call is ringing.
 * @param {string} userId
 * @param {Record<string, unknown>} payload
 */
export async function emitIncomingPhoneCall(userId, payload) {
  if (!userId || !payload) return 0;
  return emitToUser(userId, CALL_EVENTS.incomingPhoneCall, payload);
}

export default {
  serializeCall,
  buildStatusPayload,
  buildHistoryPayload,
  broadcastCallUpdate,
  broadcastRecordingReady,
  emitIncomingPhoneCall,
};
