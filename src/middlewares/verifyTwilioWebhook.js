import httpStatus from 'http-status';
import config from '../config/config.js';
import logger from '../config/logger.js';
import twilioService from '../services/twilio.service.js';

/** Reconstruct the exact public URL Twilio signed (honouring proxy headers). */
function buildPublicUrl(req) {
  const proto = req.get('X-Forwarded-Proto') || req.protocol || 'https';
  const host = req.get('X-Forwarded-Host') || req.get('host');
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Validate the Twilio webhook signature (X-Twilio-Signature).
 * @see https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function verifyTwilioWebhook(req, res, next) {
  if (!twilioService.shouldVerifyWebhooks()) {
    return next();
  }

  const authToken = (config.twilio.authToken || '').trim();
  if (!authToken) {
    return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
      success: false,
      error: 'TWILIO_AUTH_TOKEN is not configured for webhook validation.',
    });
  }

  const signature = req.get('X-Twilio-Signature') || req.get('x-twilio-signature') || '';
  if (!signature) {
    logger.warn(`[Twilio] Webhook rejected: missing signature for ${req.method} ${req.originalUrl}`);
    return res.status(httpStatus.UNAUTHORIZED).json({ success: false, error: 'Missing Twilio signature' });
  }

  const url = buildPublicUrl(req);
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const valid = twilioService.validateSignature(signature, url, params);

  if (!valid) {
    logger.warn(`[Twilio] Webhook rejected: invalid signature for ${req.method} ${req.originalUrl}`);
    return res.status(httpStatus.UNAUTHORIZED).json({ success: false, error: 'Invalid Twilio signature' });
  }

  return next();
}
