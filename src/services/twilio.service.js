/**
 * Twilio Voice client — powered by the official `twilio` Node SDK.
 *
 * Responsibilities:
 *  - REST operations: search / purchase / list / release phone numbers,
 *    fetch call resources, end calls, toggle recordings.
 *  - Access Token (JWT) signing for the mobile Voice SDK (VoiceGrant).
 *  - TwiML generation for the TwiML App Voice URL (outbound) and the purchased
 *    number's Voice URL (inbound).
 *  - Webhook signature validation (X-Twilio-Signature).
 *
 * Credentials come from the validated config (TWILIO_AUTH_ID = Account SID,
 * TWILIO_AUTH_TOKEN, TWILIO_API_SID / TWILIO_API_SECRET, TWILIO_TWIML_APP_SID,
 * TWILIO_PHONE_NUMBER). The Plivo service is left untouched — Twilio runs
 * alongside it behind CALLING_PROVIDER until cutover.
 */

import https from 'https';
import http from 'http';
import twilio from 'twilio';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { normalizePhone, validatePhone } from '../utils/phone.js';

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;
const VoiceResponse = twilio.twiml.VoiceResponse;

/** Identity used for the app's Voice SDK client, derived from the user id. */
export function clientIdentity(userId) {
  return `user_${String(userId)}`;
}

/** Parse a user id back out of a Twilio `client:user_<id>` From/To value. */
export function userIdFromClient(value) {
  if (!value) return '';
  const match = String(value).match(/(?:client:)?user_([a-f0-9]{24})/i);
  return match?.[1] || '';
}

function getConfig() {
  return { ...config.twilio };
}

/** Account-level REST client (Account SID + Auth Token). Memoised. */
let cachedClient = null;
let cachedClientKey = '';
function getClient() {
  const { accountSid, authToken } = getConfig();
  if (!accountSid || !authToken) return null;
  const key = `${accountSid}:${authToken}`;
  if (!cachedClient || cachedClientKey !== key) {
    cachedClient = twilio(accountSid, authToken);
    cachedClientKey = key;
  }
  return cachedClient;
}

/** Whether outbound calling is configured (token signing + caller id). */
function isConfigured() {
  const { accountSid, authToken, apiKeySid, apiKeySecret, twimlAppSid } = getConfig();
  return Boolean(accountSid && authToken && apiKeySid && apiKeySecret && twimlAppSid);
}

/** E.164 with leading + for storage, display, and Twilio dial targets. */
function toE164(phone) {
  if (!phone) return '';
  const trimmed = String(phone).trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

/**
 * Resolve a dial destination to a routable E.164 number, applying the same
 * country-code logic as the rest of the service (10-digit → +91 India default).
 * Naive `toE164` would turn "8290918154" into the invalid "+8290918154"; this
 * yields "+918290918154".
 */
function toDialE164(phone) {
  return normalizePhone(phone) || toE164(phone);
}

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

function getWebhookBaseUrl() {
  const { webhookBaseUrl } = getConfig();
  return normalizeWebhookBaseUrl(webhookBaseUrl || config.backendPublicUrl || '');
}

function buildWebhookUrl(path) {
  const base = getWebhookBaseUrl();
  if (!base) return '';
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}/v1${suffix}`;
}

function describeError(err) {
  if (!err) return 'Twilio request failed';
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Run a Twilio REST operation with logging and a normalized
 * `{ success, data | error, status? }` envelope.
 * @param {string} label
 * @param {(client: import('twilio').Twilio) => Promise<unknown>} fn
 */
async function runTwilio(label, fn) {
  const client = getClient();
  if (!client) {
    return { success: false, error: 'TWILIO_AUTH_ID and TWILIO_AUTH_TOKEN must be configured.' };
  }
  try {
    logger.info(`[Twilio] ${label}`);
    const data = await fn(client);
    logger.info(`[Twilio] ${label} succeeded`);
    return { success: true, data };
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : undefined;
    logger.warn(`[Twilio] ${label} failed: ${describeError(err)}`, status ? { status } : undefined);
    return { success: false, error: describeError(err), status, code: err?.code };
  }
}

/* --------------------------------------------------------------------------
 * Access Tokens (mobile Voice SDK)
 * ------------------------------------------------------------------------ */

/**
 * Sign a short-lived Access Token with a VoiceGrant for a given user.
 * @param {string} userId
 * @param {{ ttl?: number, platform?: 'ios' | 'android' }} [opts]
 */
function createAccessToken(userId, opts = {}) {
  const { accountSid, apiKeySid, apiKeySecret, twimlAppSid } = getConfig();
  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
    return {
      success: false,
      error:
        'Twilio token signing requires TWILIO_AUTH_ID, TWILIO_API_SID, TWILIO_API_SECRET and TWILIO_TWIML_APP_SID.',
    };
  }

  const identity = clientIdentity(userId);
  const ttl = Number.isFinite(opts.ttl) ? opts.ttl : 3600;

  const pushCredentialSid =
    opts.platform === 'ios'
      ? getConfig().pushCredentialSidIos
      : opts.platform === 'android'
        ? getConfig().pushCredentialSidAndroid
        : '';

  const grant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: true,
    ...(pushCredentialSid ? { pushCredentialSid } : {}),
  });

  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, { identity, ttl });
  token.addGrant(grant);

  return { success: true, token: token.toJwt(), identity, ttl };
}

/* --------------------------------------------------------------------------
 * TwiML generation
 * ------------------------------------------------------------------------ */

function statusCallbackUrl() {
  return buildWebhookUrl('/webhooks/twilio-call-status');
}

function recordingCallbackUrl() {
  return buildWebhookUrl('/webhooks/twilio-recording');
}

/**
 * Outbound TwiML — returned from the TwiML App Voice URL when the app places a
 * call via `voice.connect`. Dials the PSTN destination from the chosen caller id
 * and records the leg.
 * @param {{ to: string, callerId: string }} params
 */
function buildOutboundTwiml({ to, callerId }) {
  const response = new VoiceResponse();
  const destination = toDialE164(to);

  if (!destination || !validatePhone(destination)) {
    response.say('Sorry, that number could not be dialed. Please check the number and try again.');
    response.hangup();
    return response.toString();
  }

  const dialAttrs = {
    callerId: toE164(callerId) || getConfig().phoneNumber,
    record: 'record-from-answer-dual',
    answerOnBridge: true,
  };
  const recCb = recordingCallbackUrl();
  if (recCb) {
    dialAttrs.recordingStatusCallback = recCb;
    dialAttrs.recordingStatusCallbackEvent = 'completed';
    dialAttrs.recordingStatusCallbackMethod = 'POST';
  }

  const dial = response.dial(dialAttrs);
  const numberAttrs = {};
  const statusCb = statusCallbackUrl();
  if (statusCb) {
    numberAttrs.statusCallback = statusCb;
    numberAttrs.statusCallbackEvent = 'initiated ringing answered completed';
    numberAttrs.statusCallbackMethod = 'POST';
  }
  dial.number(numberAttrs, destination);

  return response.toString();
}

/**
 * Inbound TwiML — returned from a purchased number's Voice URL when a PSTN
 * caller dials it. Rings the resolved app user's Voice SDK client.
 * @param {{ identity: string }} params
 */
function buildInboundToClientTwiml({ identity }) {
  const response = new VoiceResponse();
  if (!identity) {
    response.say('Sorry, this number is not available right now.');
    response.hangup();
    return response.toString();
  }

  const dialAttrs = {
    record: 'record-from-answer-dual',
    answerOnBridge: true,
    timeout: 30,
  };
  const recCb = recordingCallbackUrl();
  if (recCb) {
    dialAttrs.recordingStatusCallback = recCb;
    dialAttrs.recordingStatusCallbackEvent = 'completed';
    dialAttrs.recordingStatusCallbackMethod = 'POST';
  }
  const statusCb = statusCallbackUrl();
  if (statusCb) {
    dialAttrs.action = statusCb;
    dialAttrs.method = 'POST';
  }

  const dial = response.dial(dialAttrs);
  dial.client(identity);

  return response.toString();
}

/** Graceful hangup TwiML for error paths on a Voice URL. */
function buildHangupTwiml(message = 'Unable to connect your call. Please try again.') {
  const response = new VoiceResponse();
  response.say(String(message));
  response.hangup();
  return response.toString();
}

/* --------------------------------------------------------------------------
 * Phone number management
 * ------------------------------------------------------------------------ */

/**
 * Search the Twilio catalogue for purchasable numbers.
 * @param {{ country?: string, areaCode?: number, contains?: string, type?: string, limit?: number }} params
 */
async function searchAvailableNumbers(params = {}) {
  const country = (params.country || 'US').toUpperCase();
  const type = ['local', 'mobile', 'tollFree'].includes(params.type) ? params.type : 'local';
  const listParams = {
    limit: Math.min(Number(params.limit) || 20, 30),
    voiceEnabled: true,
  };
  if (params.areaCode) listParams.areaCode = Number(params.areaCode);
  if (params.contains) listParams.contains = String(params.contains);

  const result = await runTwilio(`GET AvailablePhoneNumbers/${country}/${type}`, (client) =>
    client.availablePhoneNumbers(country)[type].list(listParams),
  );
  if (!result.success) return result;

  const numbers = (result.data || []).map((n) => ({
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    locality: n.locality,
    region: n.region,
    isoCountry: n.isoCountry,
    capabilities: n.capabilities,
  }));
  return { success: true, numbers };
}

/**
 * Purchase a number and point its Voice URL at our inbound webhook.
 * @param {{ phoneNumber: string, friendlyName?: string }} params
 */
async function purchaseNumber(params = {}) {
  const phoneNumber = toE164(params.phoneNumber);
  if (!phoneNumber) {
    return { success: false, error: 'A valid phoneNumber (E.164) is required.' };
  }

  const createParams = { phoneNumber };
  const voiceUrl = buildWebhookUrl('/voice/inbound');
  if (voiceUrl) {
    createParams.voiceUrl = voiceUrl;
    createParams.voiceMethod = 'POST';
  }
  const statusCb = statusCallbackUrl();
  if (statusCb) {
    createParams.statusCallback = statusCb;
    createParams.statusCallbackMethod = 'POST';
  }
  if (params.friendlyName) createParams.friendlyName = String(params.friendlyName);

  const result = await runTwilio('POST IncomingPhoneNumbers (purchase)', (client) =>
    client.incomingPhoneNumbers.create(createParams),
  );
  if (!result.success) return result;

  const n = result.data;
  return {
    success: true,
    number: {
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      capabilities: n.capabilities,
      voiceUrl: n.voiceUrl,
      status: n.status,
    },
    providerResponse: n,
  };
}

/**
 * Release (delete) a purchased number from the Twilio account.
 * @param {string} sid - IncomingPhoneNumber SID (PN…)
 */
async function releaseNumber(sid) {
  if (!sid) return { success: false, error: 'Number sid is required.' };
  return runTwilio(`DELETE IncomingPhoneNumbers/${sid}`, (client) =>
    client.incomingPhoneNumbers(sid).remove(),
  );
}

/* --------------------------------------------------------------------------
 * Call REST helpers
 * ------------------------------------------------------------------------ */

/** Fetch a call resource by SID. */
async function fetchCall(callSid) {
  if (!callSid) return { success: false, error: 'callSid is required' };
  const result = await runTwilio(`GET Calls/${callSid}`, (client) => client.calls(callSid).fetch());
  if (!result.success) return result;
  return { success: true, data: result.data };
}

/** End (hang up) an in-progress call. */
async function endCall(callSid) {
  if (!callSid) return { success: false, error: 'callSid is required' };
  const result = await runTwilio(`POST Calls/${callSid} (completed)`, (client) =>
    client.calls(callSid).update({ status: 'completed' }),
  );
  if (!result.success) return result;
  return { success: true, callSid, status: 'completed', providerResponse: result.data };
}

/**
 * Toggle live recording on an in-progress call.
 * @param {string} callSid
 * @param {boolean} recording
 */
async function setRecording(callSid, recording) {
  if (!callSid) return { success: false, error: 'callSid is required' };
  if (recording) {
    return runTwilio(`POST Calls/${callSid}/Recordings`, (client) =>
      client.calls(callSid).recordings.create({
        recordingStatusCallback: recordingCallbackUrl() || undefined,
        recordingStatusCallbackEvent: ['completed'],
      }),
    );
  }
  // Stop the most recent in-progress recording.
  const list = await runTwilio(`GET Calls/${callSid}/Recordings`, (client) =>
    client.calls(callSid).recordings.list({ limit: 1 }),
  );
  if (!list.success) return list;
  const rec = list.data?.[0];
  if (!rec) return { success: true, stopped: false };
  return runTwilio(`POST Recordings/${rec.sid} (stopped)`, (client) =>
    client.calls(callSid).recordings(rec.sid).update({ status: 'stopped' }),
  );
}

/** Build a publicly playable recording URL (Twilio media is .mp3 on the URL + .mp3). */
function buildRecordingMediaUrl(recordingUrl) {
  if (!recordingUrl) return null;
  const url = String(recordingUrl);
  return url.endsWith('.mp3') || url.endsWith('.wav') ? url : `${url}.mp3`;
}

/**
 * Stream a Twilio recording's media bytes to an Express response.
 *
 * Twilio's recording media endpoint (api.twilio.com/.../Recordings/RE….mp3)
 * requires HTTP Basic Auth (Account SID + Auth Token). Opening that URL directly
 * in a browser yields a 401 + login prompt — which is what the app's
 * `Linking.openURL(recordingUrl)` was hitting. This proxies the request with the
 * account credentials so an already-authenticated app user can play the audio,
 * forwarding Range headers so the in-app player can seek.
 *
 * @param {string} recordingUrl - the stored Twilio media URL
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function proxyRecordingMedia(recordingUrl, req, res) {
  const { accountSid, authToken } = getConfig();
  if (!recordingUrl) {
    res.status(404).json({ success: false, message: 'No recording available.' });
    return Promise.resolve();
  }
  if (!accountSid || !authToken) {
    res.status(503).json({ success: false, message: 'Twilio credentials not configured.' });
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(String(recordingUrl));
    } catch {
      res.status(400).json({ success: false, message: 'Invalid recording URL.' });
      return resolve();
    }

    const transport = target.protocol === 'http:' ? http : https;
    const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
    const headers = { Authorization: authHeader };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = transport.request(
      target,
      { method: 'GET', headers },
      (up) => {
        res.status(up.statusCode || 200);
        for (const name of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
          if (up.headers[name]) res.setHeader(name, up.headers[name]);
        }
        if (!up.headers['content-type']) res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        up.pipe(res);
        up.on('end', resolve);
        up.on('error', () => {
          if (!res.headersSent) res.status(502).end();
          resolve();
        });
      },
    );

    upstream.on('error', (err) => {
      logger.warn(`[Twilio] recording media proxy failed: ${describeError(err)}`);
      if (!res.headersSent) res.status(502).json({ success: false, message: 'Failed to fetch recording.' });
      resolve();
    });

    req.on('close', () => upstream.destroy());
    upstream.end();
  });
}

/* --------------------------------------------------------------------------
 * Conversational Intelligence (transcripts + AI summary)
 *
 * A Transcript is created against the configured Intelligence Service, pointing
 * at a finished call recording (source_sid = RE…). Twilio transcribes the audio
 * and runs the Service's attached Operators — including the generative
 * "Conversation Summary" operator. Results are read back via OperatorResults.
 * ------------------------------------------------------------------------ */

/** Whether Conversational Intelligence is configured (account creds + service). */
function isIntelligenceConfigured() {
  const { accountSid, authToken, intelligenceServiceSid } = getConfig();
  return Boolean(accountSid && authToken && intelligenceServiceSid);
}

function intelligenceWebhookUrl() {
  return buildWebhookUrl('/webhooks/twilio-intelligence');
}

/**
 * Create a Transcript for a finished recording.
 * @param {{ recordingSid: string, callSid?: string }} params
 */
async function createTranscript(params = {}) {
  const { intelligenceServiceSid } = getConfig();
  if (!intelligenceServiceSid) {
    return { success: false, error: 'TWILIO_INTELLIGENCE_SERVICE_SID is not configured.' };
  }
  const recordingSid = params.recordingSid ? String(params.recordingSid) : '';
  if (!recordingSid) return { success: false, error: 'recordingSid is required' };

  const createParams = {
    serviceSid: intelligenceServiceSid,
    channel: {
      // Dual-channel recordings map participant_channel 1/2 → the two legs.
      media_properties: { source_sid: recordingSid },
    },
  };
  // Tie the transcript back to the call so the completion webhook can resolve it
  // without a Recording→Call lookup.
  if (params.callSid) createParams.customerKey = String(params.callSid);

  const result = await runTwilio('POST Intelligence Transcripts', (client) =>
    client.intelligence.v2.transcripts.create(createParams),
  );
  if (!result.success) return result;
  return { success: true, sid: result.data?.sid, status: result.data?.status, data: result.data };
}

/** Fetch a Transcript resource (status lives here). */
async function fetchTranscript(transcriptSid) {
  if (!transcriptSid) return { success: false, error: 'transcriptSid is required' };
  return runTwilio(`GET Intelligence Transcripts/${transcriptSid}`, (client) =>
    client.intelligence.v2.transcripts(String(transcriptSid)).fetch(),
  );
}

/** Pull the summary text out of a generative operator result, shape-tolerant. */
function extractSummaryText(operatorResults = []) {
  for (const op of operatorResults) {
    const gen = op?.textGenerationResults ?? op?.text_generation_results;
    if (!gen) continue;
    const text =
      (typeof gen === 'string' && gen) ||
      gen.result ||
      gen.text ||
      gen.summary ||
      (Array.isArray(gen.results) ? gen.results.join('\n') : '');
    if (text && String(text).trim()) return String(text).trim();
  }
  return '';
}

/**
 * Rebuild a readable transcript from the per-sentence results.
 * @param {Array<{ mediaChannel?: number, transcript?: string }>} sentences
 */
function buildTranscriptText(sentences = []) {
  return sentences
    .map((s) => {
      const speaker = s.mediaChannel === 2 ? 'B' : 'A';
      const text = (s.transcript || '').trim();
      return text ? `${speaker}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Fetch the finished results for a transcript: status, AI summary, and the
 * reconstructed transcript text. Only reads operator/sentence sub-resources
 * once the transcript has reached `completed`.
 * @param {string} transcriptSid
 */
async function fetchTranscriptResults(transcriptSid) {
  const head = await fetchTranscript(transcriptSid);
  if (!head.success) return head;

  const status = head.data?.status || 'unknown';
  if (status !== 'completed') {
    return { success: true, status, summary: '', transcript: '', pending: status !== 'failed' };
  }

  const [opResult, sentenceResult] = await Promise.all([
    runTwilio(`GET Intelligence Transcripts/${transcriptSid}/OperatorResults`, (client) =>
      client.intelligence.v2.transcripts(String(transcriptSid)).operatorResults.list({ limit: 50 }),
    ),
    runTwilio(`GET Intelligence Transcripts/${transcriptSid}/Sentences`, (client) =>
      client.intelligence.v2.transcripts(String(transcriptSid)).sentences.list({ limit: 1000 }),
    ),
  ]);

  const summary = opResult.success ? extractSummaryText(opResult.data || []) : '';
  const transcript = sentenceResult.success ? buildTranscriptText(sentenceResult.data || []) : '';

  return { success: true, status, summary, transcript, pending: false };
}

/* --------------------------------------------------------------------------
 * Webhook signature validation
 * ------------------------------------------------------------------------ */

function shouldVerifyWebhooks() {
  if (config.twilio.verifyWebhooks === false) return false;
  if (config.twilio.verifyWebhooks === true) return true;
  return config.env === 'production';
}

/**
 * Validate an incoming Twilio webhook signature.
 * @param {string} signature - X-Twilio-Signature header
 * @param {string} url - the full public URL Twilio requested
 * @param {Record<string, unknown>} params - the POST body params
 */
function validateSignature(signature, url, params = {}) {
  const { authToken } = getConfig();
  if (!authToken || !signature) return false;
  try {
    return twilio.validateRequest(authToken, signature, url, params);
  } catch (err) {
    logger.warn(`[Twilio] Signature validation error: ${describeError(err)}`);
    return false;
  }
}

export default {
  clientIdentity,
  userIdFromClient,
  isConfigured,
  toE164,
  toDialE164,
  buildWebhookUrl,
  getWebhookBaseUrl,
  normalizeWebhookBaseUrl,
  createAccessToken,
  buildOutboundTwiml,
  buildInboundToClientTwiml,
  buildHangupTwiml,
  searchAvailableNumbers,
  purchaseNumber,
  releaseNumber,
  fetchCall,
  endCall,
  setRecording,
  buildRecordingMediaUrl,
  proxyRecordingMedia,
  isIntelligenceConfigured,
  intelligenceWebhookUrl,
  createTranscript,
  fetchTranscript,
  fetchTranscriptResults,
  shouldVerifyWebhooks,
  validateSignature,
  statusCallbackUrl,
  recordingCallbackUrl,
  getConfig,
};
