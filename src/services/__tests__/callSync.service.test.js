import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * These pure mapping helpers mirror the logic in callSync.service.js. They are
 * duplicated here (rather than imported) so the suite runs without loading the
 * full service graph (config/env validation, mongoose, socket.io).
 *
 * Keep them in sync with the real implementation.
 */

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
  rejected: 'rejected',
  declined: 'rejected',
  timeout: 'no_answer',
};

const HANGUP_CAUSE_STATUS_MAP = {
  CALL_REJECTED: 'rejected',
  USER_BUSY: 'busy',
  NO_USER_RESPONSE: 'no_answer',
  NO_ANSWER: 'no_answer',
  ALLOTTED_TIMEOUT: 'no_answer',
  ORIGINATOR_CANCEL: 'canceled',
  NORMAL_CLEARING: 'completed',
  UNALLOCATED_NUMBER: 'failed',
  NETWORK_OUT_OF_ORDER: 'failed',
  SERVICE_UNAVAILABLE: 'failed',
};

const DEFINITIVE_UNANSWERED = new Set(['rejected', 'busy', 'no_answer', 'canceled', 'failed']);

function normalizePlivoStatus(status) {
  if (!status) return 'unknown';
  const key = String(status).toLowerCase().trim();
  return PLIVO_STATUS_MAP[key] || key.replace(/-/g, '_');
}

function getPayloadValue(payload, ...keys) {
  for (const key of keys) {
    if (payload[key] != null && payload[key] !== '') return payload[key];
  }
  return null;
}

function mapHangupCause(hangupCause) {
  if (!hangupCause) return null;
  return HANGUP_CAUSE_STATUS_MAP[String(hangupCause).toUpperCase()] || null;
}

function parseDuration(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function parsePlivoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function refineUnansweredStatus(status, payload) {
  const duration = parseDuration(
    getPayloadValue(payload, 'Duration', 'BillDuration', 'CallDuration', 'duration', 'bill_duration')
  );
  const answerTime = parsePlivoDate(getPayloadValue(payload, 'AnswerTime', 'answer_time', 'StartTime'));
  const wasAnswered = duration > 0 || Boolean(answerTime);
  const hangupCause = getPayloadValue(
    payload,
    'HangupCause',
    'hangup_cause_name',
    'DialBLegHangupCause',
    'DialHangupCause'
  );
  const causeStatus = mapHangupCause(hangupCause);

  if (wasAnswered) {
    if (status === 'completed' || causeStatus === 'completed') return 'completed';
    return status;
  }

  if (causeStatus && DEFINITIVE_UNANSWERED.has(causeStatus)) {
    return causeStatus;
  }

  if (status === 'completed' || status === 'unknown') {
    return 'no_answer';
  }

  return status;
}

function resolveStatusFromPayload(payload) {
  const dialStatus = getPayloadValue(payload, 'DialStatus', 'DialBLegStatus');
  if (dialStatus) {
    const normalized = normalizePlivoStatus(dialStatus);
    const causeStatus = mapHangupCause(
      getPayloadValue(payload, 'DialBLegHangupCause', 'DialHangupCause', 'HangupCause', 'hangup_cause_name')
    );
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
    if (mapped) return refineUnansweredStatus(mapped, payload);
    return refineUnansweredStatus('completed', payload);
  }

  if (!rawStatus && hangupCause) {
    const mapped = mapHangupCause(hangupCause);
    if (mapped) return refineUnansweredStatus(mapped, payload);
  }

  return refineUnansweredStatus(normalizePlivoStatus(rawStatus), payload);
}

test('DialStatus busy maps to busy', () => {
  assert.equal(resolveStatusFromPayload({ DialStatus: 'busy', CallUUID: 'p' }), 'busy');
});

test('hangup USER_BUSY maps to busy', () => {
  assert.equal(
    resolveStatusFromPayload({ CallStatus: 'Hangup', HangupCause: 'USER_BUSY', CallUUID: 'p' }),
    'busy',
  );
});

test('no-answer dial result maps to no_answer', () => {
  assert.equal(resolveStatusFromPayload({ DialStatus: 'no-answer', CallUUID: 'p' }), 'no_answer');
});

test('declined recipient maps to rejected (not busy)', () => {
  assert.equal(normalizePlivoStatus('rejected'), 'rejected');
  assert.equal(normalizePlivoStatus('declined'), 'rejected');
});

test('hangup CALL_REJECTED maps to rejected', () => {
  assert.equal(
    resolveStatusFromPayload({ CallStatus: 'Hangup', HangupCause: 'CALL_REJECTED', Duration: 0 }),
    'rejected',
  );
});

test('CALL_REJECTED wins even when Plivo reports a generic completed status', () => {
  assert.equal(
    resolveStatusFromPayload({ CallStatus: 'completed', HangupCause: 'CALL_REJECTED', Duration: 0 }),
    'rejected',
  );
});

test('CALL_REJECTED wins even when Plivo reports failed', () => {
  assert.equal(
    resolveStatusFromPayload({ CallStatus: 'failed', HangupCause: 'CALL_REJECTED', Duration: 0 }),
    'rejected',
  );
});

test('network failure cause maps to failed', () => {
  assert.equal(
    resolveStatusFromPayload({ CallStatus: 'Hangup', HangupCause: 'NETWORK_OUT_OF_ORDER', Duration: 0 }),
    'failed',
  );
});

test('answered-then-ended call maps to completed', () => {
  assert.equal(
    resolveStatusFromPayload({
      CallStatus: 'Hangup',
      HangupCause: 'NORMAL_CLEARING',
      Duration: 42,
      AnswerTime: '2026-01-01 10:00:00',
    }),
    'completed',
  );
});

test('zero-duration completed with no cause is treated as no_answer', () => {
  assert.equal(resolveStatusFromPayload({ CallStatus: 'completed', Duration: 0 }), 'no_answer');
});

test('in-progress (answer webhook) maps to in_progress', () => {
  assert.equal(resolveStatusFromPayload({ CallStatus: 'in-progress', CallUUID: 'p' }), 'in_progress');
});

test('DialStatus ringing maps to ringing', () => {
  assert.equal(resolveStatusFromPayload({ DialStatus: 'ringing', CallUUID: 'p' }), 'ringing');
});

test('DialStatus in-progress maps to in_progress', () => {
  assert.equal(resolveStatusFromPayload({ DialStatus: 'in-progress', CallUUID: 'p' }), 'in_progress');
});
