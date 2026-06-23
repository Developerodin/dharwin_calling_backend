/**
 * Twilio Conversational Intelligence orchestration — turns a finished call
 * recording into an AI summary + transcript and persists them on the Call /
 * CallReport, broadcasting `call-summary-ready` when done.
 *
 * Two trigger paths converge here:
 *  - Automatic: the recording webhook calls `requestSummary` to kick off a
 *    Transcript; Twilio later POSTs the completion to `/webhooks/twilio-
 *    intelligence`, handled by `handleIntelligenceWebhook`.
 *  - On-demand: the app hits `GET /calls/:id/summary`, served by `ensureSummary`,
 *    which creates the transcript if needed and polls briefly for results — so
 *    summaries work even when the Service webhook isn't configured in Console.
 */

import Call from '../models/call.model.js';
import CallReport from '../models/callReport.model.js';
import twilioService from './twilio.service.js';
import callEventLog from '../utils/callEventLog.js';
import { broadcastSummaryReady } from '../socket/callBroadcast.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when CI is configured and this call has a recording worth transcribing. */
function canSummarize(call) {
  return Boolean(twilioService.isIntelligenceConfigured() && call?.recordingSid);
}

/**
 * Mirror the stored summary/transcript fields onto the call's CallReport so the
 * reports list/export carry them too.
 */
async function syncReport(call) {
  if (!call?.callSid) return;
  await CallReport.findOneAndUpdate(
    { callSid: call.callSid },
    {
      transcriptSid: call.transcriptSid || null,
      summary: call.summary || null,
      transcript: call.transcript || null,
      summaryStatus: call.summaryStatus || 'unavailable',
    },
  );
}

/**
 * Kick off a Transcript for a finished recording (idempotent). Stores the
 * transcript SID and flips summaryStatus → pending. Does not wait for results.
 * @param {import('mongoose').Document} call
 */
async function requestSummary(call) {
  if (!call || !canSummarize(call)) return null;
  if (call.transcriptSid) return call; // already requested

  const result = await twilioService.createTranscript({
    recordingSid: call.recordingSid,
    callSid: call.callSid,
  });

  if (!result.success || !result.sid) {
    callEventLog.warn('twilio.intelligence.transcript.create_failed', {
      callId: call._id?.toString(),
      callSid: call.callSid,
      error: result.error,
    });
    return null;
  }

  call.transcriptSid = result.sid;
  call.summaryStatus = 'pending';
  await call.save();
  await syncReport(call);

  callEventLog.info('twilio.intelligence.transcript.created', {
    callId: call._id?.toString(),
    callSid: call.callSid,
    transcriptSid: result.sid,
    status: result.status,
  });
  return call;
}

/**
 * Read finished results for the call's transcript and persist them. Returns the
 * updated call. No-op (returns call as-is) while the transcript is still
 * processing.
 * @param {import('mongoose').Document} call
 */
async function applyResults(call) {
  if (!call?.transcriptSid) return call;
  if (call.summaryStatus === 'ready') return call;

  const results = await twilioService.fetchTranscriptResults(call.transcriptSid);
  if (!results.success) {
    callEventLog.warn('twilio.intelligence.results.fetch_failed', {
      callSid: call.callSid,
      transcriptSid: call.transcriptSid,
      error: results.error,
    });
    return call;
  }

  if (results.status === 'failed') {
    if (call.summaryStatus !== 'failed') {
      call.summaryStatus = 'failed';
      await call.save();
      await syncReport(call);
    }
    return call;
  }

  if (results.status !== 'completed') {
    return call; // still queued / in-progress
  }

  call.summary = results.summary || call.summary || null;
  call.transcript = results.transcript || call.transcript || null;
  call.summaryStatus = 'ready';
  await call.save();
  await syncReport(call);

  callEventLog.info('twilio.intelligence.summary.ready', {
    callId: call._id?.toString(),
    callSid: call.callSid,
    transcriptSid: call.transcriptSid,
    hasSummary: Boolean(call.summary),
    hasTranscript: Boolean(call.transcript),
  });

  await broadcastSummaryReady(call);
  return call;
}

/**
 * Resolve the Call a Conversational Intelligence webhook refers to. We set
 * customer_key = callSid at creation; fall back to the stored transcript SID.
 */
async function findCallForWebhook(payload) {
  const customerKey = payload.customer_key || payload.CustomerKey;
  if (customerKey) {
    const byKey = await Call.findOne({ callSid: String(customerKey) });
    if (byKey) return byKey;
  }
  const transcriptSid = payload.transcript_sid || payload.TranscriptSid;
  if (transcriptSid) {
    return Call.findOne({ transcriptSid: String(transcriptSid) });
  }
  return null;
}

/**
 * Handle a Conversational Intelligence status webhook (transcript completed /
 * failed). Twilio POSTs `transcript_sid`, `service_sid`, `status`, `customer_key`.
 */
async function handleIntelligenceWebhook(payload = {}) {
  const status = payload.status || payload.Status;
  const transcriptSid = payload.transcript_sid || payload.TranscriptSid;

  const call = await findCallForWebhook(payload);
  if (!call) {
    callEventLog.warn('twilio.intelligence.webhook.unknown_call', { transcriptSid, status });
    return null;
  }
  // Trust the SID off the webhook in case the create response was lost.
  if (transcriptSid && !call.transcriptSid) {
    call.transcriptSid = String(transcriptSid);
    await call.save();
  }
  return applyResults(call);
}

/**
 * On-demand: guarantee a summary for a call, polling briefly. Creates the
 * transcript if one was never requested. Used by the app's "Summarize" endpoint.
 * @param {import('mongoose').Document} call
 * @param {{ attempts?: number, intervalMs?: number }} [opts]
 */
async function ensureSummary(call, opts = {}) {
  if (!call) return call;
  if (call.summaryStatus === 'ready') return call;
  if (!canSummarize(call)) return call;

  if (!call.transcriptSid) {
    const requested = await requestSummary(call);
    if (!requested) return call;
  }

  const attempts = Number.isFinite(opts.attempts) ? opts.attempts : 4;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 2500;
  for (let i = 0; i < attempts; i += 1) {
    await applyResults(call);
    if (call.summaryStatus === 'ready' || call.summaryStatus === 'failed') break;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return call;
}

export default {
  canSummarize,
  requestSummary,
  applyResults,
  handleIntelligenceWebhook,
  ensureSummary,
};
