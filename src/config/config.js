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
    // Twilio Voice. Key names mirror the existing .env (TWILIO_AUTH_ID is the
    // Twilio Account SID, AC…). All optional so the service still boots while
    // Twilio is being configured.
    TWILIO_AUTH_ID: Joi.string().optional().allow(''),
    TWILIO_AUTH_TOKEN: Joi.string().optional().allow(''),
    TWILIO_PHONE_NUMBER: Joi.string().optional().allow(''),
    TWILIO_API_SID: Joi.string().optional().allow(''),
    TWILIO_API_SECRET: Joi.string().optional().allow(''),
    TWILIO_TWIML_APP_SID: Joi.string().optional().allow(''),
    TWILIO_PUSH_CREDENTIAL_SID_IOS: Joi.string().optional().allow(''),
    TWILIO_PUSH_CREDENTIAL_SID_ANDROID: Joi.string().optional().allow(''),
    TWILIO_WEBHOOK_BASE_URL: Joi.string().optional().allow(''),
    TWILIO_INBOUND_DEFAULT_USER: Joi.string().optional().allow(''),
    TWILIO_VERIFY_WEBHOOKS: Joi.string().valid('true', 'false').optional(),
    CALLING_PROVIDER: Joi.string().valid('plivo', 'twilio').optional().default('plivo'),
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
  callingProvider: String(envVars.CALLING_PROVIDER || 'plivo').trim().toLowerCase(),
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
  twilio: {
    // TWILIO_AUTH_ID holds the Twilio Account SID (AC…).
    accountSid: String(envVars.TWILIO_AUTH_ID || '').trim(),
    authToken: String(envVars.TWILIO_AUTH_TOKEN || '').trim(),
    phoneNumber: String(envVars.TWILIO_PHONE_NUMBER || '').trim(),
    apiKeySid: String(envVars.TWILIO_API_SID || '').trim(),
    apiKeySecret: String(envVars.TWILIO_API_SECRET || '').trim(),
    twimlAppSid: String(envVars.TWILIO_TWIML_APP_SID || '').trim(),
    pushCredentialSidIos: String(envVars.TWILIO_PUSH_CREDENTIAL_SID_IOS || '').trim(),
    pushCredentialSidAndroid: String(envVars.TWILIO_PUSH_CREDENTIAL_SID_ANDROID || '').trim(),
    webhookBaseUrl: String(
      envVars.TWILIO_WEBHOOK_BASE_URL || envVars.BACKEND_PUBLIC_URL || '',
    ).trim(),
    inboundDefaultUser: String(envVars.TWILIO_INBOUND_DEFAULT_USER || '').trim(),
    verifyWebhooks:
      envVars.TWILIO_VERIFY_WEBHOOKS === 'true'
        ? true
        : envVars.TWILIO_VERIFY_WEBHOOKS === 'false'
          ? false
          : undefined,
  },
};

export default config;
