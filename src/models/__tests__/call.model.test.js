import { test } from 'node:test';
import assert from 'node:assert/strict';

const STATUS_RANK = {
  unknown: 0,
  queued: 1,
  initiated: 1,
  ringing: 2,
  in_progress: 3,
  completed: 10,
  failed: 10,
  busy: 10,
  no_answer: 10,
  canceled: 10,
};

const TERMINAL_STATUSES = ['completed', 'failed', 'busy', 'no_answer', 'canceled'];

function rankOf(status) {
  if (!status) return 0;
  return STATUS_RANK[String(status).toLowerCase()] ?? 0;
}

function isTerminal(status) {
  if (!status) return false;
  return TERMINAL_STATUSES.includes(String(status).toLowerCase());
}

test('rankOf returns monotonic ranks for call lifecycle', () => {
  assert.ok(rankOf('initiated') < rankOf('ringing'));
  assert.ok(rankOf('ringing') < rankOf('in_progress'));
  assert.ok(rankOf('in_progress') < rankOf('completed'));
});

test('isTerminal identifies terminal statuses', () => {
  assert.equal(isTerminal('completed'), true);
  assert.equal(isTerminal('in_progress'), false);
  assert.equal(isTerminal('no_answer'), true);
});
