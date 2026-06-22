import express from 'express';
import config from '../../config/config.js';
import plivoService from '../../services/plivo.service.js';
import twilioService from '../../services/twilio.service.js';
import callRoute from './call.route.js';
import contactsRoute from './contacts.route.js';
import webhookRoute from './webhook.route.js';
import twilioRoute from './twilio.route.js';

const router = express.Router();

router.get('/health', (_req, res) => {
  const webhookBase = plivoService.normalizeWebhookBaseUrl(
    config.plivo.webhookBaseUrl || config.backendPublicUrl || '',
  );
  const answerUrl = plivoService.buildWebhookUrl('/xml/answer');
  const hangupUrl = plivoService.buildWebhookUrl('/webhooks/plivo-call-status');

  const twilioVoiceUrl = twilioService.buildWebhookUrl('/voice');
  res.json({
    success: true,
    service: 'dharwinone-calling-backend',
    env: config.env,
    callingProvider: config.callingProvider,
    plivo: {
      configured: plivoService.isConfigured(),
      webhookBaseUrl: webhookBase || null,
      answerUrl: answerUrl || null,
      hangupUrl: hangupUrl || null,
      webhooksHttps: answerUrl ? answerUrl.startsWith('https://') : false,
    },
    twilio: {
      configured: twilioService.isConfigured(),
      hasTwimlApp: Boolean(twilioService.getConfig().twimlAppSid),
      hasCallerId: Boolean(twilioService.getConfig().phoneNumber),
      pushIos: Boolean(twilioService.getConfig().pushCredentialSidIos),
      pushAndroid: Boolean(twilioService.getConfig().pushCredentialSidAndroid),
      voiceUrl: twilioVoiceUrl || null,
      webhooksHttps: twilioVoiceUrl ? twilioVoiceUrl.startsWith('https://') : false,
    },
  });
});

router.use('/', callRoute);
router.use('/', twilioRoute);
router.use('/contacts', contactsRoute);
router.use('/webhooks', webhookRoute);

export default router;
