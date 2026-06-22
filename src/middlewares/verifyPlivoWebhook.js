import httpStatus from 'http-status';
import config from '../config/config.js';
import logger from '../config/logger.js';
import plivoService from '../services/plivo.service.js';

function shouldVerifyPlivoWebhooks() {
  if (config.plivo.verifyWebhooks === false) return false;
  if (config.plivo.verifyWebhooks === true) return true;
  return config.env === 'production';
}

function buildWebhookUrl(req) {
  const proto = req.get('X-Forwarded-Proto') || req.protocol || 'https';
  const host = req.get('X-Forwarded-Host') || req.get('host');
  return `${proto}://${host}${req.originalUrl}`;
}

function validateSignature(req, authToken, signatureHeader) {
  if (!signatureHeader) return false;
  const nonce = String(
    req.get('X-Plivo-Signature-V3-Nonce') || req.get('x-plivo-signature-v3-nonce') || '',
  );
  if (!nonce) return false;

  const url = buildWebhookUrl(req);
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  return plivoService.validateV3Signature(req.method, url, nonce, authToken, signatureHeader, params);
}

/**
 * Validate Plivo webhook signature (X-Plivo-Signature-V3 / X-Plivo-Signature-Ma-V3).
 * @see https://www.plivo.com/docs/voice/concepts/signature-validation
 */
export function verifyPlivoWebhook(req, res, next) {
  if (req.originalUrl?.includes('/xml/answer')) {
    logger.info(`[Plivo] Answer URL ${req.method} ${req.originalUrl}`);
  }

  if (!shouldVerifyPlivoWebhooks()) {
    return next();
  }

  const authToken = (config.plivo?.authToken || '').trim();
  if (!authToken) {
    return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
      success: false,
      error: 'PLIVO_AUTH_TOKEN is not configured for webhook validation.',
    });
  }

  const signatureV3 = String(
    req.get('X-Plivo-Signature-V3') || req.get('x-plivo-signature-v3') || '',
  );
  const signatureMaV3 = String(
    req.get('X-Plivo-Signature-Ma-V3') || req.get('x-plivo-signature-ma-v3') || '',
  );

  if (!signatureV3 && !signatureMaV3) {
    logger.warn(`[Plivo] Webhook rejected: missing signature for ${req.method} ${req.originalUrl}`);
    return res.status(httpStatus.UNAUTHORIZED).json({ success: false, error: 'Missing Plivo signature' });
  }

  const valid =
    validateSignature(req, authToken, signatureV3) ||
    validateSignature(req, authToken, signatureMaV3);

  if (!valid) {
    logger.warn(`[Plivo] Webhook rejected: invalid signature for ${req.method} ${req.originalUrl}`);
    return res.status(httpStatus.UNAUTHORIZED).json({ success: false, error: 'Invalid Plivo signature' });
  }

  next();
}
