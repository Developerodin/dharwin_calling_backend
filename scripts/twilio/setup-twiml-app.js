/**
 * One-time Twilio setup helper.
 *
 *   node scripts/twilio/setup-twiml-app.js
 *
 * - Creates (or updates) a TwiML App named "DharwinOne Calling" whose Voice URL
 *   points at <PUBLIC>/v1/voice, and prints its SID for TWILIO_TWIML_APP_SID.
 * - If TWILIO_PHONE_NUMBER is set, points that number's Voice URL at the inbound
 *   handler (<PUBLIC>/v1/voice/inbound).
 *
 * Requires TWILIO_AUTH_ID, TWILIO_AUTH_TOKEN and a public TWILIO_WEBHOOK_BASE_URL
 * (or BACKEND_PUBLIC_URL) in .env.
 */

import twilio from 'twilio';
import config from '../../src/config/config.js';
import twilioService from '../../src/services/twilio.service.js';

const APP_NAME = 'DharwinOne Calling';

async function main() {
  const { accountSid, authToken, phoneNumber } = config.twilio;
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_AUTH_ID and TWILIO_AUTH_TOKEN must be set in .env');
  }

  const voiceUrl = twilioService.buildWebhookUrl('/voice');
  const inboundUrl = twilioService.buildWebhookUrl('/voice/inbound');
  const statusCallback = twilioService.statusCallbackUrl();
  if (!voiceUrl || !voiceUrl.startsWith('https://')) {
    throw new Error(
      `Public HTTPS base URL required. Set TWILIO_WEBHOOK_BASE_URL (e.g. https://<id>.ngrok-free.app). Got voiceUrl="${voiceUrl}"`,
    );
  }

  const client = twilio(accountSid, authToken);

  // 1. TwiML App (outbound entrypoint).
  const existing = await client.applications.list({ friendlyName: APP_NAME, limit: 1 });
  let app;
  if (existing.length) {
    app = await client.applications(existing[0].sid).update({
      voiceUrl,
      voiceMethod: 'POST',
    });
    console.log(`Updated existing TwiML App: ${app.sid}`);
  } else {
    app = await client.applications.create({
      friendlyName: APP_NAME,
      voiceUrl,
      voiceMethod: 'POST',
    });
    console.log(`Created TwiML App: ${app.sid}`);
  }

  console.log('\n>>> Add this to .env:');
  console.log(`TWILIO_TWIML_APP_SID=${app.sid}\n`);

  // 2. Point the configured number at the inbound handler.
  if (phoneNumber) {
    const owned = await client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
    if (owned.length) {
      await client.incomingPhoneNumbers(owned[0].sid).update({
        voiceUrl: inboundUrl,
        voiceMethod: 'POST',
        statusCallback,
        statusCallbackMethod: 'POST',
      });
      console.log(`Configured inbound Voice URL on ${phoneNumber} -> ${inboundUrl}`);
    } else {
      console.log(`Note: ${phoneNumber} is not in this account's IncomingPhoneNumbers; skipped.`);
    }
  }

  console.log('\nDone.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Setup failed:', err.message);
    process.exit(1);
  });
