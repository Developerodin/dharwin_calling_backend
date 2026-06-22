/**
 * Plivo Voice client — powered by the official Plivo Node SDK.
 *
 * All Plivo REST operations (creating/ending/fetching calls, application and SIP
 * endpoint management), answer XML generation, and webhook signature validation
 * go through the official `plivo` SDK. Credentials are read from the validated
 * config (which itself is sourced from PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN /
 * PLIVO_PHONE_NUMBER environment variables).
 *
 * The exported interface and the data shapes returned to the rest of the app are
 * intentionally preserved (Plivo REST snake_case keys) so downstream services
 * (callSync, call, endpoint) continue to work unchanged.
 */

import plivo from 'plivo';
import config from '../config/config.js';
import logger from '../config/logger.js';
import { normalizePhone, validatePhone, validatePhonePlausible } from '../utils/phone.js';

const PLIVO_APPLICATION_NAME = 'DharwinOne_Calling';
const PLIVO_SIP_DOMAIN = 'phone.plivo.com';
const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n';

function getConfig() {
  return {
    authId: config.plivo.authId || '',
    authToken: config.plivo.authToken || '',
    phoneNumber: config.plivo.phoneNumber || '',
    webhookBaseUrl: config.plivo.webhookBaseUrl || config.backendPublicUrl || '',
    appId: config.plivo.appId || '',
  };
}

/**
 * Lazily construct and memoize the official Plivo SDK client.
 *
 * `new plivo.Client(authId, authToken)` is used with the validated config
 * credentials. The SDK also auto-reads PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN from the
 * environment when constructed with no arguments — we pass them explicitly for
 * robustness since the same values originate from those env vars.
 */
let cachedClient = null;
let cachedClientKey = '';
function getClient() {
  const { authId, authToken } = getConfig();
  if (!authId || !authToken) return null;
  const key = `${authId}:${authToken}`;
  if (!cachedClient || cachedClientKey !== key) {
    cachedClient = new plivo.Client(authId, authToken);
    cachedClientKey = key;
  }
  return cachedClient;
}

/** E.164 with leading + for storage and display. */
function toPlivoE164(phone) {
  if (!phone) return '';
  const trimmed = String(phone).trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('sip:')) return trimmed;
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

/**
 * Plivo REST calls.create expects country code + national number WITHOUT '+'.
 * @see https://www.plivo.com/docs/voice/api/call/make-a-call
 */
function toPlivoRestDialNumber(phone) {
  const e164 = toPlivoE164(phone);
  if (!e164 || e164.toLowerCase().startsWith('sip:')) return e164;
  return e164.replace(/^\+/, '');
}

/** E.164 digits only (no +) for Plivo XML <Number> and callerId attributes. */
function toPlivoXmlNumber(phone) {
  return toPlivoRestDialNumber(phone);
}

function buildSipDialTarget(username) {
  const user = String(username || '').trim();
  if (!user) return '';
  if (user.toLowerCase().startsWith('sip:')) return user;
  return `sip:${user}@${PLIVO_SIP_DOMAIN}`;
}

/** Extract a Plivo application ID from a resource URI or raw ID string. */
function normalizePlivoApplicationId(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const match = raw.match(/\/Application\/([^/]+)/i);
  if (match?.[1]) return match[1];
  return raw.replace(/\/$/, '');
}

/** Pick the outbound caller ID for PSTN legs. */
function resolveOutboundCallerId(_destinationPhone, preferredFrom) {
  const { phoneNumber } = getConfig();
  return preferredFrom || phoneNumber || '';
}

function normalizeWebhookBaseUrl(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  try {
    const parsed = new URL(trimmed);
    // Use origin only — ignore accidental path segments like /v1/webhook/...
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return trimmed.replace(/\/$/, '').replace(/\/v1.*$/, '');
  }
}

function getWebhookBaseUrl() {
  const { webhookBaseUrl, backendPublicUrl } = getConfig();
  const preferred = webhookBaseUrl || backendPublicUrl || '';
  return normalizeWebhookBaseUrl(preferred);
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname).toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.')) return true;
  return false;
}

/**
 * Plivo requires publicly reachable HTTPS webhook URLs.
 * @param {string} url
 * @param {string} fieldName
 */
function validatePlivoWebhookUrl(url, fieldName) {
  if (!url) {
    return {
      ok: false,
      error: `${fieldName} is missing. Set PLIVO_WEBHOOK_BASE_URL to your public HTTPS base URL (no path), e.g. https://abc123.ngrok-free.app`,
    };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `${fieldName} is malformed: ${url}` };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `${fieldName} must use HTTPS. Plivo rejects HTTP URLs. Run "ngrok http 3001" and set PLIVO_WEBHOOK_BASE_URL=https://<id>.ngrok-free.app`,
    };
  }

  if (isPrivateOrLocalHost(parsed.hostname)) {
    return {
      ok: false,
      error: `${fieldName} must be publicly reachable (not localhost or LAN). Use ngrok: ngrok http 3001`,
    };
  }

  return { ok: true, url };
}

function buildWebhookUrl(path) {
  const base = getWebhookBaseUrl();
  if (!base) return '';
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}/v1${suffix}`;
}

/**
 * Extract a human-readable message from an error thrown by the Plivo SDK.
 * SDK REST errors are `PlivoRestError` instances exposing `.status` and the
 * API error message on `.message`.
 */
function describePlivoError(err) {
  if (!err) return 'Plivo request failed';
  if (typeof err.message === 'string' && err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Network-level failures (no HTTP response) are retryable; HTTP responses
 * (4xx/5xx, which carry a numeric `.status`) are not.
 */
function isRetryableError(err) {
  if (err && typeof err.status === 'number') return false;
  const code = err && typeof err.code === 'string' ? err.code : '';
  const message = describePlivoError(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|timeout/i.test(
    `${code} ${message}`
  );
}

/**
 * Execute a Plivo SDK call with logging, retry on transient network errors, and
 * a normalized `{ success, data | error, status? }` envelope so call sites keep
 * their existing control flow.
 * @param {string} label
 * @param {(client: import('plivo').Client) => Promise<unknown>} fn
 * @param {number} [attempt]
 * @param {{ retry?: boolean }} [options]
 */
async function runPlivo(label, fn, attempt = 1, options = {}) {
  const { retry = true } = options;
  const client = getClient();
  if (!client) {
    return { success: false, error: 'PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN must be configured.' };
  }

  try {
    logger.info(`[Plivo] ${label}`);
    const data = await fn(client);
    logger.info(`[Plivo] ${label} succeeded`);
    return { success: true, data };
  } catch (err) {
    if (retry && isRetryableError(err) && attempt < 3) {
      const delayMs = attempt * 500;
      logger.warn(
        `[Plivo] ${label} network error (attempt ${attempt}/3), retrying in ${delayMs}ms`,
        { error: describePlivoError(err) }
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return runPlivo(label, fn, attempt + 1, options);
    }

    const status = typeof err?.status === 'number' ? err.status : undefined;
    const message = isRetryableError(err)
      ? 'Unable to reach Plivo API. Check internet connection and retry.'
      : describePlivoError(err);
    logger.warn(`[Plivo] ${label} failed: ${message}`, status ? { status } : undefined);
    return { success: false, error: message, status };
  }
}

/**
 * Map a Plivo SDK call resource (camelCase) back to the Plivo REST CDR
 * snake_case shape that downstream services expect.
 * @param {Record<string, unknown>} resp
 */
function snakeCaseCallResource(resp) {
  if (!resp || typeof resp !== 'object') return resp;
  const pick = (camel, snake) => resp[camel] ?? resp[snake];
  return {
    ...resp,
    api_id: pick('apiId', 'api_id'),
    answer_time: pick('answerTime', 'answer_time'),
    bill_duration: pick('billDuration', 'bill_duration'),
    billed_duration: pick('billedDuration', 'billed_duration'),
    call_direction: pick('callDirection', 'call_direction'),
    call_duration: pick('callDuration', 'call_duration'),
    call_state: pick('callState', 'call_state'),
    call_uuid: pick('callUuid', 'call_uuid'),
    conference_uuid: pick('conferenceUuid', 'conference_uuid'),
    end_time: pick('endTime', 'end_time'),
    from_number: pick('fromNumber', 'from_number'),
    hangup_cause_code: pick('hangupCauseCode', 'hangup_cause_code'),
    hangup_cause_name: pick('hangupCauseName', 'hangup_cause_name'),
    hangup_source: pick('hangupSource', 'hangup_source'),
    initiation_time: pick('initiationTime', 'initiation_time'),
    parent_call_uuid: pick('parentCallUuid', 'parent_call_uuid'),
    resource_uri: pick('resourceUri', 'resource_uri'),
    to_number: pick('toNumber', 'to_number'),
    total_amount: pick('totalAmount', 'total_amount'),
    total_rate: pick('totalRate', 'total_rate'),
  };
}

function buildBridgedAnswerUrl(callId, retry = 0) {
  const base = buildWebhookUrl('/xml/answer');
  if (!base || !callId) return base;
  const id = encodeURIComponent(String(callId));
  const retryParam = retry > 0 ? `&retry=${encodeURIComponent(String(retry))}` : '';
  return `${base}?bridge=sip&callId=${id}${retryParam}`;
}

/**
 * Hold the answered PSTN leg while waiting for the caller's Browser SDK SIP
 * endpoint to register, then redirect back to the bridged answer URL.
 */
function buildBridgedWaitXml(callId, retry = 0, maxRetries = 20) {
  const response = new plivo.Response();
  if (retry >= maxRetries) {
    response.addSpeak('Unable to connect to the caller. Please try again.');
    response.addHangup({});
    return XML_PROLOG + response.toXML();
  }

  response.addSpeak('Please hold while we connect your call.');
  response.addWait({ length: 1 });
  response.addRedirect(buildBridgedAnswerUrl(callId, retry + 1), { method: 'GET' });
  return XML_PROLOG + response.toXML();
}

/**
 * Retry bridging after a failed Dial User leg — keeps the answered PSTN party
 * on the line while the caller's SDK endpoint registers or re-answers.
 * @param {string} callId
 */
function buildBridgedDialRetryXml(callId) {
  const response = new plivo.Response();
  response.addWait({ length: 1 });
  response.addRedirect(buildBridgedAnswerUrl(callId, 0), { method: 'GET' });
  return XML_PROLOG + response.toXML();
}

/** Minimal hold XML used when the primary answer URL fails. */
function buildFallbackHoldAnswerXml() {
  const response = new plivo.Response();
  response.addSpeak('Please hold while we connect your call.');
  response.addWait({ length: 30 });
  return XML_PROLOG + response.toXML();
}

function buildFallbackAnswerUrl() {
  return `${buildWebhookUrl('/xml/answer')}?fallback=hold`;
}

/**
 * Validate a PSTN destination via Plivo Number Lookup before placing a call.
 * @param {string} phone - E.164 phone number
 */
async function lookupPhoneNumber(phone) {
  const e164 = toPlivoE164(phone);
  if (!e164 || e164.toLowerCase().startsWith('sip:')) {
    return { success: false, error: 'Invalid phone number' };
  }

  const result = await runPlivo(
    'GET /Number (lookup)',
    (client) => client.lookup.get(e164, 'carrier'),
    1,
    { retry: false },
  );

  if (!result.success) {
    return {
      success: false,
      error: result.error || 'Number lookup failed',
      status: result.status,
    };
  }

  const carrier = result.data?.carrier || {};
  return {
    success: true,
    e164: result.data?.phoneNumber || result.data?.phone_number || e164,
    country: result.data?.country?.iso2 || result.data?.country?.iso2 || '',
    carrierName: carrier.name || '',
    carrierType: carrier.type || '',
    providerResponse: result.data,
  };
}

/**
 * Initiate an outbound call (server mode) via the Plivo SDK.
 * @param {{ to?: string, sipUsername?: string, from?: string, answerUrl?: string }} params
 */
async function initiateCall(params) {
  const { phoneNumber } = getConfig();
  const from = params.from || phoneNumber;
  if (!from) {
    return { success: false, error: 'PLIVO_PHONE_NUMBER is not configured.' };
  }

  const sipUsername = params.sipUsername ? String(params.sipUsername).trim() : '';
  let recipientDial = '';
  let receiverNumber = '';

  if (sipUsername) {
    recipientDial = buildSipDialTarget(sipUsername);
    receiverNumber = recipientDial;
  } else {
    if (!params.to) {
      return { success: false, error: 'Missing required field: to' };
    }

    const recipientPhone = normalizePhone(params.to);
    if (!recipientPhone || !validatePhone(recipientPhone)) {
      return {
        success: false,
        error: 'Invalid phone number format. Use E.164 (e.g. +918755887760) or 10-digit number.',
      };
    }
    if (!validatePhonePlausible(recipientPhone)) {
      return { success: false, error: 'Phone number is not a valid callable line.' };
    }

    recipientDial = toPlivoE164(recipientPhone);
    receiverNumber = recipientPhone;
  }

  const answerUrl = params.answerUrl || buildWebhookUrl('/xml/answer');
  const ringUrl = buildWebhookUrl('/webhooks/plivo-call-ring');
  const hangupUrl = buildWebhookUrl('/webhooks/plivo-call-status');

  const answerCheck = validatePlivoWebhookUrl(answerUrl, 'answer_url');
  if (!answerCheck.ok) {
    return { success: false, error: answerCheck.error };
  }

  const hangupCheck = validatePlivoWebhookUrl(hangupUrl, 'hangup_url');
  if (!hangupCheck.ok) {
    return { success: false, error: hangupCheck.error };
  }

  const options = {
    answerMethod: 'POST',
    hangupUrl,
    hangupMethod: 'POST',
    timeLimit: 7200,
  };

  const ringCheck = validatePlivoWebhookUrl(ringUrl, 'ring_url');
  if (ringCheck.ok) {
    options.ringUrl = ringUrl;
    options.ringMethod = 'POST';
  } else {
    logger.warn(`[Plivo] Omitting ring_url: ${ringCheck.error}`);
  }

  const fallbackAnswerUrl = buildFallbackAnswerUrl();
  const fallbackCheck = validatePlivoWebhookUrl(fallbackAnswerUrl, 'fallback_answer_url');
  if (fallbackCheck.ok) {
    options.fallbackAnswerUrl = fallbackAnswerUrl;
    options.fallbackMethod = 'POST';
  } else {
    logger.warn(`[Plivo] Omitting fallback_answer_url: ${fallbackCheck.error}`);
  }

  const restFrom = toPlivoRestDialNumber(from);
  const restTo = sipUsername ? recipientDial : toPlivoRestDialNumber(recipientDial);

  logger.info(`[Plivo] Dialing ${restFrom} -> ${restTo}`);

  // Never retry outbound call creation — a lost response can leave an orphan Plivo call ringing.
  const result = await runPlivo(
    'POST /Call (server)',
    (client) => client.calls.create(restFrom, restTo, answerUrl, options),
    1,
    { retry: false }
  );
  if (!result.success) return result;

  const callUuid = result.data?.requestUuid || result.data?.request_uuid;
  if (!callUuid) {
    return { success: false, error: 'Plivo did not return a call UUID.', data: result.data };
  }

  const providerResponse = {
    request_uuid: callUuid,
    api_id: result.data?.apiId,
    message: result.data?.message,
  };

  return {
    success: true,
    callSid: callUuid,
    status: 'queued',
    callerNumber: from,
    receiverNumber,
    providerResponse,
  };
}

/**
 * Server-initiated dial for client-mode calls. When the callee answers,
 * the answer URL bridges the call to the caller's registered SIP endpoint.
 * @param {{ to?: string, sipUsername?: string, callId: string, from?: string }} params
 */
async function initiateBridgedClientCall(params) {
  if (!params.callId) {
    return { success: false, error: 'callId is required' };
  }
  if (!params.sipUsername && !params.to) {
    return { success: false, error: 'to or sipUsername is required' };
  }

  const answerUrl = buildBridgedAnswerUrl(params.callId);
  return initiateCall({
    to: params.to,
    sipUsername: params.sipUsername,
    from: params.from,
    answerUrl,
  });
}

/**
 * End an active call.
 * @param {string} callUuid
 */
async function endCall(callUuid) {
  if (!callUuid) {
    return { success: false, error: 'callSid is required' };
  }
  const result = await runPlivo('DELETE /Call', (client) => client.calls.hangup(callUuid));
  if (!result.success) return result;
  return {
    success: true,
    callSid: callUuid,
    status: 'completed',
    providerResponse: result.data,
  };
}

/**
 * Fetch call details from Plivo. Returns the data in the Plivo REST snake_case
 * shape expected by callSync.
 * @param {string} callUuid
 */
async function fetchCall(callUuid) {
  if (!callUuid) {
    return { success: false, error: 'callSid is required' };
  }
  const result = await runPlivo('GET /Call', (client) => client.calls.get(callUuid));
  if (!result.success) return result;
  return { success: true, data: snakeCaseCallResource(result.data) };
}

/**
 * Start recording an in-progress call via the Plivo REST API.
 * @param {string} callUuid
 */
async function startCallRecording(callUuid) {
  if (!callUuid) {
    return { success: false, error: 'callSid is required' };
  }

  const recordParams = {
    timeLimit: 7200,
    fileFormat: 'mp3',
    ...buildRecordCallbackAttrs(),
  };

  const result = await runPlivo('POST /Call/Record', (client) =>
    client.calls.record(callUuid, recordParams)
  );
  if (!result.success) return result;
  return { success: true, callSid: callUuid, providerResponse: result.data };
}

/**
 * Stop recording an in-progress call via the Plivo REST API.
 * @param {string} callUuid
 */
async function stopCallRecording(callUuid) {
  if (!callUuid) {
    return { success: false, error: 'callSid is required' };
  }

  const result = await runPlivo('DELETE /Call/Record', (client) =>
    client.calls.stopRecording(callUuid)
  );
  if (!result.success) return result;
  return { success: true, callSid: callUuid, providerResponse: result.data };
}

function buildRecordingMediaUrl(recordingUrl) {
  if (!recordingUrl) return null;
  return String(recordingUrl);
}

/**
 * Build the recording callback attributes object for the <Record> element.
 */
function buildRecordCallbackAttrs() {
  const recordingCallback = buildWebhookUrl('/webhooks/plivo-recording');
  if (!recordingCallback) return {};
  return { callbackUrl: recordingCallback, callbackMethod: 'POST' };
}

/** Empty Plivo XML — required for Dial action URL responses. */
function buildEmptyResponseXml() {
  return XML_PROLOG + new plivo.Response().toXML();
}

/** Graceful hangup XML when the answer URL handler fails or cannot bridge. */
function buildAnswerHangupXml(message = 'Unable to connect your call. Please try again.') {
  const response = new plivo.Response();
  response.addSpeak(String(message || 'Unable to connect your call. Please try again.'));
  response.addHangup({});
  return XML_PROLOG + response.toXML();
}

/**
 * Server-initiated PSTN call answer XML (record + hold), built with the SDK XML
 * generator (`plivo.Response`).
 */
function buildOutboundAnswerXml() {
  const response = new plivo.Response();
  response.addRecord({ recordSession: true, fileFormat: 'mp3', ...buildRecordCallbackAttrs() });
  response.addWait({ length: 7200 });
  return XML_PROLOG + response.toXML();
}

/**
 * Answer XML for the SDK inbound leg of a server-bridged PSTN call. The PSTN
 * destination is already connected — do not Dial again or the callee will ring
 * a second time.
 */
function buildBridgedSdkLegAnswerXml() {
  const response = new plivo.Response();
  response.addWait({ length: 7200 });
  return XML_PROLOG + response.toXML();
}

/**
 * Bridge XML used when a PSTN callee has already answered and we need to
 * connect the caller's registered SDK endpoint. Uses a longer dial timeout
 * because the app must receive onIncomingCall and call client.answer().
 * @param {{ sipUsername: string, callerId?: string }} params
 */
function buildBridgedPstnToSdkAnswerXml(params = {}) {
  const sipUsername = params.sipUsername ? String(params.sipUsername).trim() : '';
  if (!sipUsername) {
    return buildAnswerHangupXml('Unable to connect to the caller.');
  }

  const response = new plivo.Response();
  const dialAttrs = { timeout: 45 };
  const dialActionUrl = buildWebhookUrl('/webhooks/plivo-dial-status');
  if (dialActionUrl) {
    dialAttrs.action = dialActionUrl;
    dialAttrs.method = 'POST';
  }

  const dial = response.addDial(dialAttrs);
  dial.addUser(sipUsername);

  return XML_PROLOG + response.toXML();
}

/**
 * Bridge/client answer XML — record the session and bridge to a PSTN number or
 * registered app SIP endpoint.
 * @param {{ to?: string, sipUsername?: string, callerId?: string }} params
 */
function buildClientAnswerXml(params = {}) {
  const { phoneNumber } = getConfig();
  const destination = params.to || '';
  const sipUsername = params.sipUsername ? String(params.sipUsername).trim() : '';
  const callerId = params.callerId || phoneNumber || '';

  const response = new plivo.Response();

  if (!destination && !sipUsername) {
    response.addSpeak('Missing destination number.');
    response.addHangup({});
    return XML_PROLOG + response.toXML();
  }

  const dialAttrs = {};
  const dialActionUrl = buildWebhookUrl('/webhooks/plivo-dial-status');
  if (dialActionUrl) {
    dialAttrs.action = dialActionUrl;
    dialAttrs.method = 'POST';
  }
  dialAttrs.timeout = 30;

  // PSTN bridge: record once the dialed party answers. SIP bridge: callee is
  // already on the line — just connect the app endpoint with a minimal Dial.
  if (destination) {
    if (callerId) dialAttrs.callerId = toPlivoXmlNumber(callerId);
    response.addRecord({
      recordSession: true,
      startOnDialAnswer: true,
      fileFormat: 'mp3',
      ...buildRecordCallbackAttrs(),
    });
  }

  const dial = response.addDial(dialAttrs);
  if (sipUsername) {
    dial.addUser(sipUsername);
  } else {
    dial.addNumber(toPlivoXmlNumber(destination));
  }

  return XML_PROLOG + response.toXML();
}

async function getConfiguredApplication() {
  const { appId } = getConfig();
  if (!appId) return null;

  const result = await runPlivo('GET /Application', (client) => client.applications.get(appId));
  if (!result.success) return null;

  return {
    appId,
    data: result.data,
  };
}

async function listApplications() {
  return runPlivo('GET /Application list', (client) => client.applications.list({ limit: 20 }));
}

async function findApplicationByName(name) {
  const result = await listApplications();
  if (!result.success) return null;
  const objects = Array.isArray(result.data) ? result.data : result.data?.objects || [];
  return objects.find((app) => (app.appName || app.app_name) === name) || null;
}

/**
 * List child call legs for a parent Plivo call UUID. Returns Plivo REST
 * snake_case call objects.
 * @param {string} parentCallUuid
 */
async function listCallsByParent(parentCallUuid) {
  if (!parentCallUuid) {
    return { success: false, error: 'parentCallUuid is required' };
  }

  const result = await runPlivo('GET /Call (by parent)', (client) =>
    client.calls.list({ parentCallUuid, limit: 20 })
  );
  if (!result.success) return result;

  const objects = Array.isArray(result.data) ? result.data : result.data?.objects || [];
  return {
    success: true,
    calls: objects.map(snakeCaseCallResource),
  };
}

/**
 * Build the application webhook params object (camelCase for the SDK).
 * ring_url is only valid on outbound Call API requests, not Application resources.
 */
function buildApplicationWebhookBody() {
  const answerUrl = buildWebhookUrl('/xml/answer');
  const hangupUrl = buildWebhookUrl('/webhooks/plivo-call-status');

  const answerCheck = validatePlivoWebhookUrl(answerUrl, 'answer_url');
  if (!answerCheck.ok) {
    return { success: false, error: answerCheck.error };
  }

  const hangupCheck = validatePlivoWebhookUrl(hangupUrl, 'hangup_url');
  if (!hangupCheck.ok) {
    return { success: false, error: hangupCheck.error };
  }

  const fallbackAnswerUrl = buildFallbackAnswerUrl();
  const fallbackCheck = validatePlivoWebhookUrl(fallbackAnswerUrl, 'fallback_answer_url');
  const body = {
    answerUrl,
    answerMethod: 'POST',
    hangupUrl,
    hangupMethod: 'POST',
    defaultEndpointApp: true,
  };
  if (fallbackCheck.ok) {
    body.fallbackAnswerUrl = fallbackAnswerUrl;
    body.fallbackMethod = 'POST';
  } else {
    logger.warn(`[Plivo] Omitting application fallback_answer_url: ${fallbackCheck.error}`);
  }

  return {
    success: true,
    body,
  };
}

function extractApplicationAnswerUrl(appData) {
  if (!appData) return '';
  return String(
    appData.answerUrl ||
      appData.answer_url ||
      appData.providerResponse?.answerUrl ||
      appData.providerResponse?.answer_url ||
      '',
  ).trim();
}

async function getApplication(appId) {
  if (!appId) {
    return { success: false, error: 'appId is required' };
  }

  const result = await runPlivo('GET /Application', (client) => client.applications.get(appId));
  if (!result.success) return result;

  const data = result.data || {};
  return {
    success: true,
    appId: String(appId),
    answerUrl: extractApplicationAnswerUrl(data),
    hangupUrl: String(data.hangupUrl || data.hangup_url || '').trim(),
    data,
  };
}

async function updateApplication(appId) {
  if (!appId) {
    return { success: false, error: 'appId is required' };
  }

  const webhookBody = buildApplicationWebhookBody();
  if (!webhookBody.success) {
    return { success: false, error: webhookBody.error };
  }

  const result = await runPlivo('POST /Application (update)', (client) =>
    client.applications.update(appId, webhookBody.body)
  );
  if (!result.success) return result;

  const remote = await getApplication(appId);
  const expectedAnswerUrl = webhookBody.body.answerUrl;
  const remoteAnswerUrl = remote.success ? remote.answerUrl : '';
  if (expectedAnswerUrl && remoteAnswerUrl && remoteAnswerUrl !== expectedAnswerUrl) {
    logger.warn(
      `[Plivo] Application ${appId} answer_url mismatch after update (expected ${expectedAnswerUrl}, got ${remoteAnswerUrl})`,
    );
  } else if (expectedAnswerUrl) {
    logger.info(`[Plivo] Application ${appId} answer_url verified: ${remoteAnswerUrl || expectedAnswerUrl}`);
  }

  return {
    success: true,
    appId: String(appId),
    answerUrl: remoteAnswerUrl || expectedAnswerUrl,
    providerResponse: result.data,
  };
}

async function createApplication() {
  const existing = await findApplicationByName(PLIVO_APPLICATION_NAME);
  const existingAppId = existing && (existing.appId || existing.app_id);
  if (existingAppId) {
    logger.info(`[Plivo] Reusing application ${existingAppId} (${PLIVO_APPLICATION_NAME})`);
    const updated = await updateApplication(String(existingAppId));
    if (!updated.success) {
      return { success: false, error: updated.error || 'Failed to refresh Plivo application webhooks' };
    }
    return {
      success: true,
      appId: String(existingAppId),
      answerUrl: updated.answerUrl,
      providerResponse: existing,
    };
  }

  const webhookBody = buildApplicationWebhookBody();
  if (!webhookBody.success) {
    return { success: false, error: webhookBody.error };
  }

  const result = await runPlivo('POST /Application (create)', (client) =>
    client.applications.create(PLIVO_APPLICATION_NAME, webhookBody.body)
  );
  if (!result.success) return result;

  const appId = result.data?.appId || result.data?.app_id;
  if (!appId) {
    return { success: false, error: 'Plivo did not return an application ID.', data: result.data };
  }

  return {
    success: true,
    appId: String(appId),
    providerResponse: result.data,
  };
}

async function createEndpoint({ username, password, alias, appId }) {
  if (!username || !password) {
    return { success: false, error: 'username and password are required' };
  }

  const endpointAlias = alias || username;
  const result = await runPlivo('POST /Endpoint', (client) =>
    client.endpoints.create(username, password, endpointAlias, appId || undefined)
  );
  if (!result.success) return result;

  const endpointId = result.data?.endpointId || result.data?.endpoint_id;

  return {
    success: true,
    endpointId: endpointId ? String(endpointId) : null,
    username: result.data?.username || username,
    alias: result.data?.alias || endpointAlias,
    providerResponse: result.data,
  };
}

async function getEndpoint(endpointId) {
  if (!endpointId) {
    return { success: false, error: 'endpointId is required' };
  }

  const result = await runPlivo(`GET /Endpoint/${endpointId}`, (client) =>
    client.endpoints.get(endpointId)
  );
  if (!result.success) return result;

  return {
    success: true,
    endpointId: String(result.data?.endpointId || result.data?.endpoint_id || endpointId),
    username: result.data?.username || '',
    password: result.data?.password || '',
    appId: normalizePlivoApplicationId(
      result.data?.application || result.data?.app_id || result.data?.appId || '',
    ),
    providerResponse: result.data,
  };
}

async function updateEndpoint(endpointId, { password, appId, alias } = {}) {
  if (!endpointId) {
    return { success: false, error: 'endpointId is required' };
  }

  const params = { isVoiceRequest: 'true' };
  if (password) params.password = password;
  if (appId) params.app_id = appId;
  if (alias) params.alias = alias;

  if (!password && !appId && !alias) {
    return { success: false, error: 'No endpoint fields to update' };
  }

  const result = await runPlivo(`POST /Endpoint/${endpointId}`, (client) =>
    client.endpoints.update(endpointId, params)
  );
  if (!result.success) return result;

  return {
    success: true,
    endpointId: String(endpointId),
    providerResponse: result.data,
  };
}

async function deleteEndpoint(endpointId) {
  if (!endpointId) {
    return { success: false, error: 'endpointId is required' };
  }

  return runPlivo(`DELETE /Endpoint/${endpointId}`, (client) => client.endpoints.delete(endpointId));
}

function isConfigured() {
  const { authId, authToken, phoneNumber } = getConfig();
  return Boolean(authId && authToken && phoneNumber);
}

/**
 * Validate a Plivo V3 webhook signature using the official SDK.
 * @see https://www.plivo.com/docs/voice/concepts/signature-validation
 * @param {string} method
 * @param {string} url
 * @param {string} nonce
 * @param {string} authToken
 * @param {string} signatureHeader
 * @param {Record<string, unknown>} [params]
 */
function validateV3Signature(method, url, nonce, authToken, signatureHeader, params = {}) {
  if (!signatureHeader || !nonce || !authToken) return false;
  try {
    return plivo.validateV3Signature(method, url, nonce, authToken, signatureHeader, params);
  } catch (err) {
    logger.warn(`[Plivo] Signature validation error: ${describePlivoError(err)}`);
    return false;
  }
}

export default {
  initiateCall,
  initiateBridgedClientCall,
  buildBridgedAnswerUrl,
  buildBridgedDialRetryXml,
  buildFallbackAnswerUrl,
  buildFallbackHoldAnswerXml,
  lookupPhoneNumber,
  toPlivoRestDialNumber,
  resolveOutboundCallerId,
  normalizePlivoApplicationId,
  getApplication,
  endCall,
  fetchCall,
  startCallRecording,
  stopCallRecording,
  listCallsByParent,
  buildRecordingMediaUrl,
  buildOutboundAnswerXml,
  buildBridgedPstnToSdkAnswerXml,
  buildBridgedSdkLegAnswerXml,
  buildClientAnswerXml,
  buildBridgedWaitXml,
  buildAnswerHangupXml,
  buildEmptyResponseXml,
  getConfiguredApplication,
  createApplication,
  updateApplication,
  createEndpoint,
  getEndpoint,
  updateEndpoint,
  deleteEndpoint,
  buildWebhookUrl,
  normalizeWebhookBaseUrl,
  validatePlivoWebhookUrl,
  validateV3Signature,
  isConfigured,
  getConfig,
};
