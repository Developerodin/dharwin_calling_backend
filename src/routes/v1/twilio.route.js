import express from 'express';
import httpStatus from 'http-status';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import { verifyTwilioWebhook } from '../../middlewares/verifyTwilioWebhook.js';
import * as twilioValidation from '../../validations/twilio.validation.js';
import * as twilioController from '../../controllers/twilio.controller.js';
import * as twilioVoiceController from '../../controllers/twilioVoice.controller.js';
import twilioService from '../../services/twilio.service.js';
import callEventLog from '../../utils/callEventLog.js';

const router = express.Router();

/* ---- Public Twilio-facing endpoints (validated by X-Twilio-Signature) ---- */

router.route('/voice').post(verifyTwilioWebhook, twilioVoiceController.outboundVoice);
router.route('/voice/inbound').post(verifyTwilioWebhook, twilioVoiceController.inboundVoice);
router
  .route('/webhooks/twilio-call-status')
  .post(verifyTwilioWebhook, twilioVoiceController.callStatusWebhook);
router
  .route('/webhooks/twilio-recording')
  .post(verifyTwilioWebhook, twilioVoiceController.recordingWebhook);

/* ---- Authenticated app endpoints ---- */

router
  .route('/telephony/token')
  .get(
    auth(),
    requirePermissions('calls.read'),
    validate(twilioValidation.getAccessToken),
    twilioController.getAccessToken,
  );

router
  .route('/numbers/available')
  .get(
    auth(),
    requirePermissions('calls.read'),
    validate(twilioValidation.searchNumbers),
    twilioController.searchNumbers,
  );

router
  .route('/numbers')
  .get(
    auth(),
    requirePermissions('calls.read'),
    validate(twilioValidation.listNumbers),
    twilioController.listNumbers,
  );

router
  .route('/numbers/purchase')
  .post(
    auth(),
    requirePermissions('calls.manage'),
    validate(twilioValidation.purchaseNumber),
    twilioController.purchaseNumber,
  );

router
  .route('/numbers/:sid')
  .delete(
    auth(),
    requirePermissions('calls.manage'),
    validate(twilioValidation.releaseNumber),
    twilioController.releaseNumber,
  );

/** Twilio Voice URLs must always return TwiML — never a JSON error payload. */
router.use((err, req, res, next) => {
  const isVoiceUrl = req.originalUrl?.includes('/voice');
  if (!isVoiceUrl || res.headersSent) {
    return next(err);
  }
  callEventLog.error('twilio.voice.middleware_error', {
    method: req.method,
    path: req.originalUrl,
    error: err?.message,
  });
  res.setHeader('Content-Type', 'text/xml');
  return res.status(httpStatus.OK).send(twilioService.buildHangupTwiml());
});

export default router;
