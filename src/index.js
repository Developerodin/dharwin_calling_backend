import dns from 'dns';
import http from 'http';
import mongoose from 'mongoose';
import app from './app.js';
import config from './config/config.js';
import logger from './config/logger.js';
import { initRealtime } from './socket/realtime.js';

// Avoid intermittent Node fetch failures to external APIs (e.g. Plivo) on dual-stack networks.
dns.setDefaultResultOrder('ipv4first');

mongoose.set('strictQuery', true);

mongoose.connect(config.mongoose.url).then(() => {
  logger.info('Connected to MongoDB');
});

const server = http.createServer(app);

// Attach the realtime (Socket.IO) layer to the same HTTP server so the app can
// receive call-state updates in real time over WebSockets.
initRealtime(server);

server.listen(config.port, '0.0.0.0', () => {
  const webhookBase = config.plivo.webhookBaseUrl || config.backendPublicUrl || '';
  logger.info(`Calling backend listening on port ${config.port} (0.0.0.0)`);
  logger.info('[Socket] WebSocket endpoint available at /socket.io');
  if (webhookBase) {
    logger.info(`[Plivo] Webhook base URL: ${webhookBase}`);
    logger.info(`[Plivo] Answer XML: ${webhookBase}/v1/xml/answer`);
  } else {
    logger.warn('[Plivo] PLIVO_WEBHOOK_BASE_URL is not set — Plivo cannot reach webhooks. Run ngrok and update .env.');
  }
});

const exitHandler = () => {
  if (server) {
    server.close(() => {
      logger.info('Server closed');
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
};

const unexpectedErrorHandler = (error) => {
  logger.error(error);
  exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);
process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  if (server) server.close();
});
