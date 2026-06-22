import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatusPayload } from '../../socket/callBroadcast.js';

test('buildStatusPayload maps call record to socket contract', () => {
  const record = {
    _id: 'mongo-id-1',
    callSid: 'plivo-uuid-abc',
    status: 'rejected',
    duration: 0,
    errorMessage: 'CALL_REJECTED',
    receiverNumber: '+919876543210',
    callerNumber: '+911234567890',
    direction: 'outbound',
    statusUpdatedAt: new Date('2026-06-17T12:00:00.000Z'),
    toJSON() {
      return {
        id: this._id,
        callSid: this.callSid,
        status: this.status,
        duration: this.duration,
        errorMessage: this.errorMessage,
        receiverNumber: this.receiverNumber,
        callerNumber: this.callerNumber,
        direction: this.direction,
      };
    },
  };

  const payload = buildStatusPayload(record);
  assert.ok(payload);
  assert.equal(payload.callUUID, 'plivo-uuid-abc');
  assert.equal(payload.callId, 'mongo-id-1');
  assert.equal(payload.status, 'rejected');
  assert.equal(payload.hangupCause, 'CALL_REJECTED');
  assert.equal(payload.duration, 0);
  assert.ok(payload.updatedAt);
});
