import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Joi from 'joi';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    PORT: Joi.number().default(3001),
    MONGODB_URL: Joi.string().required().description('MongoDB URL for calling service'),
    JWT_SECRET: Joi.string().min(32).required().description('Same secret as main DharwinOne backend'),
    CORS_ORIGIN: Joi.string().allow('').optional(),
    BACKEND_PUBLIC_URL: Joi.string().optional().default('http://localhost:3001'),
    PLIVO_AUTH_ID: Joi.string().optional().allow(''),
    PLIVO_AUTH_TOKEN: Joi.string().optional().allow(''),
    PLIVO_PHONE_NUMBER: Joi.string().optional().allow(''),
    PLIVO_WEBHOOK_BASE_URL: Joi.string().optional().allow(''),
    PLIVO_APP_ID: Joi.string().optional().allow(''),
    PLIVO_VERIFY_WEBHOOKS: Joi.string().valid('true', 'false').optional(),
    TRUST_PROXY_HOPS: Joi.number().optional().default(0),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const config = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  mongoose: {
    url: envVars.MONGODB_URL,
  },
  jwt: {
    secret: envVars.JWT_SECRET,
  },
  corsOrigin: envVars.CORS_ORIGIN || '',
  backendPublicUrl: String(envVars.BACKEND_PUBLIC_URL || 'http://localhost:3001').trim(),
  trustProxyHops: envVars.TRUST_PROXY_HOPS ?? 0,
  plivo: {
    authId: String(envVars.PLIVO_AUTH_ID || '').trim(),
    authToken: String(envVars.PLIVO_AUTH_TOKEN || '').trim(),
    phoneNumber: String(envVars.PLIVO_PHONE_NUMBER || '').trim(),
    webhookBaseUrl: String(envVars.PLIVO_WEBHOOK_BASE_URL || envVars.BACKEND_PUBLIC_URL || '').trim(),
    appId: envVars.PLIVO_APP_ID || '',
    verifyWebhooks:
      envVars.PLIVO_VERIFY_WEBHOOKS === 'true'
        ? true
        : envVars.PLIVO_VERIFY_WEBHOOKS === 'false'
          ? false
          : undefined,
  },
};

export default config;
