import express from 'express';
import config from '../../config/config.js';
import plivoService from '../../services/plivo.service.js';
import callRoute from './call.route.js';
import contactsRoute from './contacts.route.js';
import webhookRoute from './webhook.route.js';

const router = express.Router();

router.get('/health', (_req, res) => {
  const webhookBase = plivoService.normalizeWebhookBaseUrl(
    config.plivo.webhookBaseUrl || config.backendPublicUrl || '',
  );
  const answerUrl = plivoService.buildWebhookUrl('/xml/answer');
  const hangupUrl = plivoService.buildWebhookUrl('/webhooks/plivo-call-status');

  res.json({
    success: true,
    service: 'dharwinone-calling-backend',
    env: config.env,
    plivo: {
      configured: plivoService.isConfigured(),
      webhookBaseUrl: webhookBase || null,
      answerUrl: answerUrl || null,
      hangupUrl: hangupUrl || null,
      webhooksHttps: answerUrl ? answerUrl.startsWith('https://') : false,
    },
  });
});

router.use('/', callRoute);
router.use('/contacts', contactsRoute);
router.use('/webhooks', webhookRoute);

export default router;
