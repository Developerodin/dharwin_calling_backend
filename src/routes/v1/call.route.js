import express from 'express';
import httpStatus from 'http-status';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as callValidation from '../../validations/call.validation.js';
import * as callController from '../../controllers/call.controller.js';
import * as telephonyController from '../../controllers/telephony.controller.js';
import { verifyPlivoWebhook } from '../../middlewares/verifyPlivoWebhook.js';
import plivoService from '../../services/plivo.service.js';
import callEventLog from '../../utils/callEventLog.js';

const router = express.Router();

/** Answer XML — Plivo fetches this when an outbound/SDK call needs instructions. */
router
  .route('/xml/answer')
  .get(verifyPlivoWebhook, callController.outboundAnswerXml)
  .post(verifyPlivoWebhook, callController.outboundAnswerXml);

router
  .route('/telephony/credentials')
  .get(auth(), requirePermissions('calls.read'), telephonyController.getCredentials);

router
  .route('/telephony/registration')
  .get(auth(), requirePermissions('calls.read'), telephonyController.getRegistrationStatus);

router
  .route('/telephony/phone')
  .put(auth(), requirePermissions('calls.read'), telephonyController.registerPhone);

router
  .route('/calls')
  .post(auth(), requirePermissions('calls.manage'), validate(callValidation.makeCall), callController.makeCall)
  .get(auth(), requirePermissions('calls.read'), validate(callValidation.listCallHistory), callController.listCallHistory);

router
  .route('/calls/register')
  .post(
    auth(),
    requirePermissions('calls.manage'),
    validate(callValidation.registerClientCall),
    callController.registerClientCall
  );

router
  .route('/calls/:id/server-dial')
  .post(
    auth(),
    requirePermissions('calls.manage'),
    validate(callValidation.dialServerLeg),
    callController.dialServerLeg
  );

router
  .route('/calls/:id')
  .get(auth(), requirePermissions('calls.read'), validate(callValidation.getCallDetails), callController.getCallDetails);

router
  .route('/calls/:id/status')
  .get(auth(), requirePermissions('calls.read'), validate(callValidation.getCallStatus), callController.getCallStatus);

router
  .route('/calls/:id/recording/media')
  .get(
    auth(),
    requirePermissions('calls.read'),
    validate(callValidation.getCallDetails),
    callController.streamCallRecording
  );

router
  .route('/calls/:id/summary')
  .get(
    auth(),
    requirePermissions('calls.read'),
    validate(callValidation.getCallDetails),
    callController.getCallSummary
  );

router
  .route('/calls/:id/mute')
  .post(auth(), requirePermissions('calls.manage'), validate(callValidation.setMute), callController.setMute);

router
  .route('/calls/:id/recording')
  .post(
    auth(),
    requirePermissions('calls.manage'),
    validate(callValidation.setRecording),
    callController.setRecording
  );

router
  .route('/calls/:callSid/end')
  .post(auth(), requirePermissions('calls.manage'), validate(callValidation.endCall), callController.endCall);

router
  .route('/recordings')
  .get(auth(), requirePermissions('calls.read'), validate(callValidation.listRecordings), callController.listRecordings);

router
  .route('/recordings/:id')
  .get(auth(), requirePermissions('calls.read'), validate(callValidation.getRecording), callController.getRecording);

router
  .route('/reports')
  .get(auth(), requirePermissions('calls.read'), validate(callValidation.listReports), callController.listReports);

router
  .route('/reports/export')
  .get(auth(), requirePermissions('calls.read'), validate(callValidation.exportReports), callController.exportReports);

/** Plivo answer URLs must always return XML — never JSON error payloads. */
router.use((err, req, res, next) => {
  if (!req.originalUrl?.includes('/xml/answer') || res.headersSent) {
    return next(err);
  }

  callEventLog.error('webhook.answer_xml.middleware_error', {
    method: req.method,
    path: req.originalUrl,
    error: err?.message,
  });

  res.setHeader('Content-Type', 'text/xml');
  return res.status(httpStatus.OK).send(plivoService.buildAnswerHangupXml());
});

export default router;
