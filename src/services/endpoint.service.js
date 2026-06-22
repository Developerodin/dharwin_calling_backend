import crypto from 'crypto';
import httpStatus from 'http-status';
import SipEndpoint from '../models/sipEndpoint.model.js';
import ApiError from '../utils/ApiError.js';
import { normalizePhone } from '../utils/phone.js';
import plivoService from './plivo.service.js';
import savedContactService from './savedContact.service.js';
import logger from '../config/logger.js';

const PLIVO_SIP_DOMAIN = 'phone.plivo.com';
const WEBHOOK_REFRESH_INTERVAL_MS = 60_000;
const lastWebhookRefreshByApp = new Map();

function buildUsername(userId) {
  const suffix = String(userId).replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'user';
  const rand = crypto.randomBytes(3).toString('hex');
  return `dharwin${suffix}${rand}`.slice(0, 50);
}

function buildPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function buildAlias(userId) {
  const suffix = String(userId).replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'user';
  return `Dharwin${suffix}`.slice(0, 50);
}

async function ensureApplication() {
  const configured = await plivoService.getConfiguredApplication();
  if (configured?.appId) {
    const updated = await plivoService.updateApplication(configured.appId);
    if (!updated.success) {
      logger.warn(`[Plivo] Failed to refresh application webhooks: ${updated.error}`);
    }
    return configured;
  }

  const stored = await SipEndpoint.findOne({ appId: { $ne: null } }).sort({ createdAt: 1 });
  if (stored?.appId) {
    const updated = await plivoService.updateApplication(stored.appId);
    if (!updated.success) {
      logger.warn(`[Plivo] Failed to refresh application webhooks: ${updated.error}`);
    }
    return { appId: stored.appId };
  }

  const created = await plivoService.createApplication();
  if (!created.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, created.error || 'Failed to create Plivo application');
  }

  logger.info(`[Plivo] Created application ${created.appId}`);
  return created;
}

async function createEndpointForUser(userId, application) {
  const username = buildUsername(userId);
  const password = buildPassword();

  const created = await plivoService.createEndpoint({
    username,
    password,
    alias: buildAlias(userId),
    appId: application.appId,
  });

  if (!created.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, created.error || 'Failed to create Plivo SIP endpoint');
  }

  const record = await SipEndpoint.create({
    user: userId,
    username: created.username || username,
    password,
    endpointId: created.endpointId || null,
    alias: created.alias || '',
    appId: application.appId,
    providerResponse: created.providerResponse || {},
  });

  return record;
}

async function recreateEndpointForUser(userId, application) {
  await SipEndpoint.deleteMany({ user: userId });
  return createEndpointForUser(userId, application);
}

/**
 * Keep MongoDB SIP credentials aligned with Plivo before the mobile SDK logs in.
 * Rotates the endpoint password on Plivo and persists it locally.
 */
async function syncEndpointCredentials(endpoint, application) {
  if (!endpoint?.endpointId) {
    logger.warn(`[Plivo] Missing endpointId for user ${endpoint?.user}; recreating SIP endpoint`);
    return recreateEndpointForUser(endpoint.user, application);
  }

  const remote = await plivoService.getEndpoint(endpoint.endpointId);
  if (!remote.success) {
    const missing = remote.status === 404;
    logger.warn(
      `[Plivo] SIP endpoint ${endpoint.endpointId} ${missing ? 'not found' : 'lookup failed'}: ${remote.error}`,
    );
    if (missing) {
      return recreateEndpointForUser(endpoint.user, application);
    }
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      remote.error || 'Failed to verify Plivo SIP endpoint',
    );
  }

  const password = buildPassword();
  const updated = await plivoService.updateEndpoint(endpoint.endpointId, {
    password,
    appId: application.appId,
  });

  if (!updated.success) {
    if (updated.status === 404) {
      return recreateEndpointForUser(endpoint.user, application);
    }
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      updated.error || 'Failed to refresh Plivo SIP credentials',
    );
  }

  endpoint.password = password;
  endpoint.appId = application.appId;
  if (remote.username && remote.username !== endpoint.username) {
    endpoint.username = remote.username;
  }
  await endpoint.save();

  logger.info(`[Plivo] Refreshed SIP credentials for endpoint ${endpoint.endpointId}`);
  return endpoint;
}

async function ensureEndpointForUser(userId) {
  const existing = await SipEndpoint.findOne({ user: userId });
  if (existing) return existing;

  const application = await ensureApplication();
  return createEndpointForUser(userId, application);
}

async function refreshApplicationWebhooks(appId, options = {}) {
  if (!appId) return;
  const { force = false } = options;
  const now = Date.now();
  const last = lastWebhookRefreshByApp.get(String(appId)) || 0;
  if (!force && now - last < WEBHOOK_REFRESH_INTERVAL_MS) {
    return;
  }

  const updated = await plivoService.updateApplication(appId);
  if (!updated.success) {
    logger.warn(`[Plivo] Failed to refresh application webhooks for ${appId}: ${updated.error}`);
    return;
  }

  lastWebhookRefreshByApp.set(String(appId), now);
}

async function syncEndpointApplicationLink(endpoint, application) {
  if (!endpoint?.endpointId || !application?.appId) return endpoint;

  const remote = await plivoService.getEndpoint(endpoint.endpointId);
  if (!remote.success) return endpoint;

  const remoteAppId = plivoService.normalizePlivoApplicationId(
    remote.appId || remote.providerResponse?.application || '',
  );
  const expectedAppId = plivoService.normalizePlivoApplicationId(application.appId);
  if (remoteAppId === expectedAppId) return endpoint;

  logger.warn(
    `[Plivo] Relinking SIP endpoint ${endpoint.endpointId} to application ${expectedAppId} (was ${remoteAppId || 'unset'})`,
  );
  const updated = await plivoService.updateEndpoint(endpoint.endpointId, { appId: expectedAppId });
  if (!updated.success) {
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      updated.error || 'Failed to link Plivo SIP endpoint to calling application',
    );
  }

  endpoint.appId = expectedAppId;
  await endpoint.save();
  return endpoint;
}

/**
 * Ensure the Plivo Application answer_url and SIP endpoint application link are
 * ready before the mobile SDK places an outbound call.
 */
async function prepareSdkOutbound(userId) {
  const application = await ensureApplication();
  const updated = await plivoService.updateApplication(application.appId);
  if (!updated.success) {
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      updated.error || 'Failed to sync Plivo application webhooks for SDK outbound calling',
    );
  }

  const expectedAnswerUrl = plivoService.buildWebhookUrl('/xml/answer');
  if (expectedAnswerUrl && updated.answerUrl && updated.answerUrl !== expectedAnswerUrl) {
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      'Plivo application answer_url does not match the configured webhook base URL. Update PLIVO_WEBHOOK_BASE_URL and retry.',
    );
  }

  let endpoint = await SipEndpoint.findOne({ user: userId });
  if (!endpoint) {
    endpoint = await createEndpointForUser(userId, application);
  } else {
    endpoint = await syncEndpointApplicationLink(endpoint, application);
  }

  return {
    appId: application.appId,
    answerUrl: updated.answerUrl || expectedAnswerUrl,
    endpointId: endpoint?.endpointId || null,
    username: endpoint?.username || null,
  };
}

async function getCredentialsForUser(userId, options = {}) {
  const { rotateCredentials = false, skipApplicationSync = false } = options;
  const application = await ensureApplication();
  let endpoint = await SipEndpoint.findOne({ user: userId });
  if (!endpoint) {
    endpoint = await createEndpointForUser(userId, application);
  } else if (rotateCredentials) {
    endpoint = await syncEndpointCredentials(endpoint, application);
  } else if (!endpoint.endpointId) {
    endpoint = await recreateEndpointForUser(userId, application);
  } else {
    const remote = await plivoService.getEndpoint(endpoint.endpointId);
    if (!remote.success) {
      const missing = remote.status === 404;
      logger.warn(
        `[Plivo] SIP endpoint ${endpoint.endpointId} ${missing ? 'not found' : 'lookup failed'} during credential read: ${remote.error}`,
      );
      if (missing) {
        endpoint = await recreateEndpointForUser(userId, application);
      } else {
        throw new ApiError(
          httpStatus.BAD_GATEWAY,
          remote.error || 'Failed to verify Plivo SIP endpoint',
        );
      }
    } else if (!skipApplicationSync) {
      endpoint = await syncEndpointApplicationLink(endpoint, application);
    }
  }

  // SDK outbound legs use the Plivo Application answer_url (not per-call URLs).
  await refreshApplicationWebhooks(endpoint.appId, { force: rotateCredentials });
  const { phoneNumber } = plivoService.getConfig();

  return {
    username: endpoint.username,
    password: endpoint.password,
    callerId: phoneNumber || '',
    endpointId: endpoint.endpointId,
    appId: endpoint.appId,
  };
}

function buildSipUri(username) {
  const user = String(username || '').trim();
  if (!user) return '';
  if (user.startsWith('sip:')) return user;
  return `sip:${user}@${PLIVO_SIP_DOMAIN}`;
}

async function findEndpointByPhone(phone) {
  if (!phone) return null;

  const normalized = normalizePhone(String(phone).trim());
  if (!normalized) return null;

  const exact = await SipEndpoint.findOne({ phoneNumber: normalized });
  if (exact) return exact;

  const candidates = await SipEndpoint.find({
    phoneNumber: { $exists: true, $ne: '' },
  }).limit(200);

  return (
    candidates.find((endpoint) => savedContactService.phonesMatch(endpoint.phoneNumber, normalized)) ||
    null
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isEndpointRegistered(userId) {
  const endpoint = await SipEndpoint.findOne({ user: userId });
  if (!endpoint?.endpointId) {
    return { registered: false, username: endpoint?.username || null, endpointId: null };
  }

  const remote = await plivoService.getEndpoint(endpoint.endpointId);
  if (!remote.success) {
    return {
      registered: false,
      username: endpoint.username,
      endpointId: endpoint.endpointId,
      error: remote.error,
    };
  }

  const raw =
    remote.providerResponse?.sipRegistered ??
    remote.providerResponse?.sip_registered ??
    'false';
  const registered = String(raw).toLowerCase() === 'true';

  return {
    registered,
    username: endpoint.username,
    endpointId: endpoint.endpointId,
    sipUri: remote.providerResponse?.sipUri || remote.providerResponse?.sip_uri || buildSipUri(endpoint.username),
  };
}

/** Poll Plivo until the user's Browser SDK SIP endpoint is registered. */
async function waitForEndpointRegistered(userId, maxMs = 15_000) {
  const deadline = Date.now() + maxMs;
  let latest = await isEndpointRegistered(userId);

  while (!latest.registered && Date.now() < deadline) {
    await sleep(500);
    latest = await isEndpointRegistered(userId);
  }

  return latest;
}

async function updateEndpointPhone(userId, phone) {
  const normalized = normalizePhone(String(phone || '').trim());
  if (!userId || !normalized) return null;

  const endpoint = await SipEndpoint.findOne({ user: userId });
  if (!endpoint) return null;

  if (endpoint.phoneNumber === normalized) return endpoint;

  endpoint.phoneNumber = normalized;
  await endpoint.save();
  logger.info(`[Plivo] Updated SIP endpoint phone for user ${userId} → ${normalized}`);
  return endpoint;
}

export default {
  ensureEndpointForUser,
  getCredentialsForUser,
  prepareSdkOutbound,
  refreshApplicationWebhooks,
  isEndpointRegistered,
  waitForEndpointRegistered,
  buildSipUri,
  findEndpointByPhone,
  updateEndpointPhone,
};
