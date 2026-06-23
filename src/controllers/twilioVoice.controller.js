/**
 * Public Twilio-facing endpoints (no user JWT — validated by X-Twilio-Signature):
 *  - POST /voice          TwiML App Voice URL — outbound from the app SDK.
 *  - POST /voice/inbound  Purchased number Voice URL — inbound PSTN → app client.
 *  - POST /webhooks/twilio-call-status  Call status / Dial action callback.
 *  - POST /webhooks/twilio-recording    Recording-ready callback.
 *
 * Voice URLs MUST always return TwiML (text/xml), never JSON, or Twilio drops
 * the call.
 */

import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import twilioService from '../services/twilio.service.js';
import twilioCallSync from '../services/twilioCallSync.service.js';
import twilioIntelligence from '../services/twilioIntelligence.service.js';
import numberService from '../services/twilioNumber.service.js';
import callEventLog from '../utils/callEventLog.js';

function sendTwiml(res, xml) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(httpStatus.OK).send(xml);
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** POST /voice — outbound. App's `voice.connect` lands here via the TwiML App. */
const outboundVoice = catchAsync(async (req, res) => {
  try {
    const body = req.body || {};
    const callSid = body.CallSid;
    const userId = twilioService.userIdFromClient(body.From);
    const destination = twilioService.toDialE164(body.To || body.PhoneNumber || '');
    const callerId = await numberService.resolveCallerId(userId, body.CallerId || body.From);

    if (callSid && userId) {
      await twilioCallSync.seedCall({
        callSid,
        userId,
        direction: 'outbound',
        callerNumber: callerId,
        receiverNumber: destination,
        status: 'ringing',
      });
    }

    callEventLog.info('twilio.voice.outbound', { callSid, userId, to: destination, callerId });
    return sendTwiml(res, twilioService.buildOutboundTwiml({ to: destination, callerId }));
  } catch (err) {
    callEventLog.error('twilio.voice.outbound.error', { error: err?.message });
    return sendTwiml(res, twilioService.buildHangupTwiml());
  }
});

/** POST /voice/inbound — inbound. A purchased number was dialled. */
const inboundVoice = catchAsync(async (req, res) => {
  try {
    const body = req.body || {};
    const callSid = body.CallSid;
    const calledNumber = body.To || body.Called || '';
    const callerNumber = body.From || body.Caller || '';

    const owner = await numberService.findOwnerByNumber(calledNumber);
    const ownerUserId = owner?.user ? String(owner.user) : '';

    if (!ownerUserId) {
      callEventLog.warn('twilio.voice.inbound.unrouted', { callSid, calledNumber });
      return sendTwiml(res, twilioService.buildHangupTwiml('This number is not available right now.'));
    }

    if (callSid) {
      await twilioCallSync.seedCall({
        callSid,
        userId: ownerUserId,
        direction: 'inbound',
        callerNumber,
        receiverNumber: calledNumber,
        status: 'ringing',
      });
    }

    const identity = twilioService.clientIdentity(ownerUserId);
    callEventLog.info('twilio.voice.inbound', { callSid, calledNumber, identity });
    return sendTwiml(res, twilioService.buildInboundToClientTwiml({ identity }));
  } catch (err) {
    callEventLog.error('twilio.voice.inbound.error', { error: err?.message });
    return sendTwiml(res, twilioService.buildHangupTwiml());
  }
});

/** POST /webhooks/twilio-call-status — status + Dial-action callback. */
const callStatusWebhook = catchAsync(async (req, res) => {
  await twilioCallSync.applyCallStatusWebhook(req.body || {});
  // Valid for both statusCallback (body ignored) and <Dial action> (TwiML).
  return sendTwiml(res, EMPTY_TWIML);
});

/** POST /webhooks/twilio-recording — recording-ready callback. */
const recordingWebhook = catchAsync(async (req, res) => {
  await twilioCallSync.applyRecordingWebhook(req.body || {});
  return res.status(httpStatus.OK).json({ success: true });
});

/** POST /webhooks/twilio-intelligence — Conversational Intelligence transcript callback. */
const intelligenceWebhook = catchAsync(async (req, res) => {
  await twilioIntelligence.handleIntelligenceWebhook(req.body || {});
  return res.status(httpStatus.OK).json({ success: true });
});

export { outboundVoice, inboundVoice, callStatusWebhook, recordingWebhook, intelligenceWebhook };
