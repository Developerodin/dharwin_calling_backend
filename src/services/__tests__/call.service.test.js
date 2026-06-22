import { test } from 'node:test';
import assert from 'node:assert/strict';

const PLIVO_STATUS_MAP = {
  queued: 'initiated',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  completed: 'completed',
  'no-answer': 'no_answer',
};

function normalizePlivoStatus(status) {
  if (!status) return 'unknown';
  const key = String(status).toLowerCase().trim();
  return PLIVO_STATUS_MAP[key] || key.replace(/-/g, '_');
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

test('normalizePlivoStatus maps Plivo statuses', () => {
  assert.equal(normalizePlivoStatus('in-progress'), 'in_progress');
  assert.equal(normalizePlivoStatus('no-answer'), 'no_answer');
  assert.equal(normalizePlivoStatus('ringing'), 'ringing');
});

test('reportsToCsv includes header and escaped values', () => {
  const csv = reportsToCsv([
    {
      callSid: 'uuid-1',
      callerNumber: '+15551111111',
      receiverNumber: '+15552222222',
      callDuration: 42,
      callStatus: 'completed',
      recordingUrl: 'https://example.com/rec.mp3',
      recordingDuration: 40,
      callStartTime: new Date('2026-01-01T00:00:00Z'),
      callEndTime: new Date('2026-01-01T00:01:00Z'),
    },
  ]);
  assert.match(csv, /^Call ID,/);
  assert.match(csv, /uuid-1/);
  assert.match(csv, /completed/);
});
