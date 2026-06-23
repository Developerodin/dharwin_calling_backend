/**
 * Verify Conversational Intelligence end-to-end, without the app.
 *
 *   node scripts/twilio/test-summary.js <RecordingSid | CallSid>
 *   node scripts/twilio/test-summary.js RE0123...        # a recording
 *   node scripts/twilio/test-summary.js CA0123...        # resolves the call's latest recording
 *   node scripts/twilio/test-summary.js                  # picks the account's most recent recording
 *
 * Creates a Transcript against TWILIO_INTELLIGENCE_SERVICE_SID, polls until it
 * completes, then prints the AI summary + speaker-labelled transcript. Uses the
 * exact same service helpers the backend uses, so a green run here means the app
 * path (recording webhook + GET /calls/:id/summary) will work too.
 *
 * Requires TWILIO_AUTH_ID, TWILIO_AUTH_TOKEN, TWILIO_INTELLIGENCE_SERVICE_SID.
 */

import twilio from 'twilio';
import config from '../../src/config/config.js';
import twilioService from '../../src/services/twilio.service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve the input arg to a Recording SID (RE…). */
async function resolveRecordingSid(client, arg) {
  if (arg && /^RE[0-9a-f]{32}$/i.test(arg)) return arg;

  if (arg && /^CA[0-9a-f]{32}$/i.test(arg)) {
    const recs = await client.calls(arg).recordings.list({ limit: 1 });
    if (!recs.length) throw new Error(`Call ${arg} has no recordings.`);
    console.log(`Resolved call ${arg} -> recording ${recs[0].sid}`);
    return recs[0].sid;
  }

  if (arg) throw new Error(`Unrecognized SID "${arg}" (expected RE… or CA…).`);

  const recs = await client.recordings.list({ limit: 1 });
  if (!recs.length) throw new Error('No recordings found on this account.');
  console.log(`No SID given — using most recent recording ${recs[0].sid}`);
  return recs[0].sid;
}

async function main() {
  const { accountSid, authToken, intelligenceServiceSid } = config.twilio;
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_AUTH_ID and TWILIO_AUTH_TOKEN must be set in .env');
  }
  if (!intelligenceServiceSid) {
    throw new Error('TWILIO_INTELLIGENCE_SERVICE_SID must be set in .env');
  }
  console.log(`Service: ${intelligenceServiceSid}`);

  const client = twilio(accountSid, authToken);
  const recordingSid = await resolveRecordingSid(client, process.argv[2]);

  console.log('\nCreating transcript…');
  const created = await twilioService.createTranscript({ recordingSid, callSid: 'test-script' });
  if (!created.success) throw new Error(`Create failed: ${created.error}`);
  const transcriptSid = created.sid;
  console.log(`Transcript: ${transcriptSid} (status: ${created.status})`);

  console.log('\nPolling for results (up to ~2 min)…');
  let results = null;
  for (let i = 0; i < 24; i += 1) {
    results = await twilioService.fetchTranscriptResults(transcriptSid);
    if (!results.success) throw new Error(`Fetch failed: ${results.error}`);
    process.stdout.write(`  [${i + 1}] status=${results.status}\n`);
    if (results.status === 'completed' || results.status === 'failed') break;
    await sleep(5000);
  }

  console.log('\n========================================');
  if (results.status !== 'completed') {
    console.log(`Transcript did not complete (status: ${results.status}).`);
    process.exitCode = 1;
    return;
  }

  console.log('AI SUMMARY:\n');
  console.log(results.summary || '(empty — is the "Conversation Summary" operator attached to the Service?)');
  console.log('\n----------------------------------------');
  console.log('TRANSCRIPT:\n');
  console.log(results.transcript || '(no sentences returned)');
  console.log('========================================');

  if (!results.summary) {
    console.log('\n⚠ Summary was empty. Attach the generative "Conversation Summary" operator to the Service in the Twilio Console, then re-run.');
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('\nTest failed:', err.message);
    process.exit(1);
  });
