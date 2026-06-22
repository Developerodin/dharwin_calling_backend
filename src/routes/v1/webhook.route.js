import express from 'express';
import * as callController from '../../controllers/call.controller.js';
import { verifyPlivoWebhook } from '../../middlewares/verifyPlivoWebhook.js';

const router = express.Router();

router
  .route('/plivo-call-ring')
  .post(verifyPlivoWebhook, callController.receiveCallRingWebhook);

router
  .route('/plivo-call-status')
  .post(verifyPlivoWebhook, callController.receiveCallStatusWebhook);

router
  .route('/plivo-dial-status')
  .post(verifyPlivoWebhook, callController.receiveDialStatusWebhook);

router
  .route('/plivo-recording')
  .post(verifyPlivoWebhook, callController.receiveRecordingWebhook);

export default router;
