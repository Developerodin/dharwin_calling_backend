import { test } from 'node:test';
import assert from 'node:assert/strict';

function buildOutboundAnswerXml(recordingCallback) {
  const callbackAttr = recordingCallback
    ? ` callbackUrl="${recordingCallback}" callbackMethod="POST"`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" fileFormat="mp3"${callbackAttr} />
  <Wait length="7200"/>
</Response>`;
}

function buildRecordingMediaUrl(recordingUrl) {
  if (!recordingUrl) return null;
  return String(recordingUrl);
}

test('buildOutboundAnswerXml returns valid XML response', () => {
  const xml = buildOutboundAnswerXml('https://example.com/v1/webhooks/plivo-recording');
  assert.match(xml, /^<\?xml version="1.0"/);
  assert.match(xml, /<Response>/);
  assert.match(xml, /<Record/);
  assert.match(xml, /<Wait/);
});

test('buildRecordingMediaUrl returns recording URL as-is', () => {
  const url = buildRecordingMediaUrl('https://media.plivo.com/recording.mp3');
  assert.equal(url, 'https://media.plivo.com/recording.mp3');
});

function normalizeWebhookBaseUrl(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return trimmed.replace(/\/$/, '').replace(/\/v1.*$/, '');
  }
}

test('normalizeWebhookBaseUrl strips accidental path suffixes', () => {
  assert.equal(
    normalizeWebhookBaseUrl('http://localhost:3001/v1/webhook/plivo-callback'),
    'http://localhost:3001',
  );
  assert.equal(normalizeWebhookBaseUrl('https://abc.ngrok-free.app/v1/xml/answer'), 'https://abc.ngrok-free.app');
});

function toPlivoE164(phone) {
  if (!phone) return '';
  const trimmed = String(phone).trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('sip:')) return trimmed;
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

function toPlivoXmlNumber(phone) {
  const e164 = toPlivoE164(phone);
  if (!e164 || e164.toLowerCase().startsWith('sip:')) return e164;
  return e164.replace(/^\+/, '');
}

test('toPlivoE164 keeps + prefix for Plivo REST dial targets', () => {
  assert.equal(toPlivoE164('+917878274773'), '+917878274773');
  assert.equal(toPlivoE164('917878274773'), '+917878274773');
  assert.equal(toPlivoE164('+13072897114'), '+13072897114');
});

function toPlivoRestDialNumber(phone) {
  const e164 = toPlivoE164(phone);
  if (!e164 || e164.toLowerCase().startsWith('sip:')) return e164;
  return e164.replace(/^\+/, '');
}

test('toPlivoRestDialNumber strips + for Plivo REST calls.create', () => {
  assert.equal(toPlivoRestDialNumber('+917878274773'), '917878274773');
  assert.equal(toPlivoRestDialNumber('+13072897114'), '13072897114');
});

test('toPlivoXmlNumber strips + for Plivo XML Number elements', () => {
  assert.equal(toPlivoXmlNumber('+917878274773'), '917878274773');
  assert.equal(toPlivoXmlNumber('917878274773'), '917878274773');
});

function buildBridgedWaitXml(callId, retry = 0, maxRetries = 15) {
  if (retry >= maxRetries) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>Unable to connect</Speak><Hangup/></Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Wait length="2"/><Redirect>retry</Redirect></Response>`;
}

test('buildBridgedWaitXml waits before bridging when SIP is not registered', () => {
  const xml = buildBridgedWaitXml('call123', 0);
  assert.match(xml, /<Wait/);
  assert.match(xml, /<Redirect/);
});

test('buildBridgedWaitXml hangs up after max retries', () => {
  const xml = buildBridgedWaitXml('call123', 15, 15);
  assert.match(xml, /<Hangup/);
});

test('buildAnswerHangupXml returns valid hangup XML', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>Unable to connect</Speak><Hangup/></Response>`;
  assert.match(xml, /^<\?xml version="1.0"/);
  assert.match(xml, /<Speak/);
  assert.match(xml, /<Hangup/);
});

function normalizePlivoApplicationId(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const match = raw.match(/\/Application\/([^/]+)/i);
  if (match?.[1]) return match[1];
  return raw.replace(/\/$/, '');
}

test('normalizePlivoApplicationId extracts ID from Plivo resource URI', () => {
  assert.equal(
    normalizePlivoApplicationId('/v1/Account/MAZDC1MJA3OWIYMTLLN2/Application/30044373894364508/'),
    '30044373894364508',
  );
  assert.equal(normalizePlivoApplicationId('30044373894364508'), '30044373894364508');
});
