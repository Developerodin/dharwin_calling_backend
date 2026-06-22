import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import mongoSanitize from 'express-mongo-sanitize';
import config from './config/config.js';
import routes from './routes/v1/index.js';
import requestId from './middlewares/requestId.js';
import { errorConverter, errorHandler } from './middlewares/error.js';
import logger from './config/logger.js';

const app = express();

if (config.trustProxyHops > 0) {
  app.set('trust proxy', config.trustProxyHops);
}

app.use(helmet());
app.use(requestId);
app.use(compression());

const corsOrigins =
  config.env === 'development'
    ? true
    : config.corsOrigin
      ? config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
      : true;
app.use(cors({ origin: corsOrigins, credentials: true }));

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(mongoSanitize());

app.use('/v1', routes);

app.use(errorConverter);
app.use(errorHandler);

app.on('error', (err) => {
  logger.error(`Express error: ${err.message}`);
});

export default app;
