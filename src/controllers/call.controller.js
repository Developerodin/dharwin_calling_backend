import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import Call from '../models/call.model.js';
import SipEndpoint from '../models/sipEndpoint.model.js';
import callService from '../services/call.service.js';
import callSyncService from '../services/callSync.service.js';
import endpointService from '../services/endpoint.service.js';
import plivoService from '../services/plivo.service.js';
import callEventLog from '../utils/callEventLog.js';
import { userIsAdmin } from '../utils/authHelpers.js';

const getUserId = (req) => req.user?.id || req.user?._id;

function extractSipUsernameFromPlivoFrom(fromValue) {
  if (!fromValue) return '';
  const raw = String(fromValue);
  const sipMatch = raw.match(/sip:([^@;>]+)/i);
  if (sipMatch?.[1]) return sipMatch[1];
  if (raw.includes('@phone.plivo.com')) {
    return raw.replace(/^sip:/i, '').split('@')[0];
  }
  return '';
}

function sendPlivoXml(res, xml, statusCode = httpStatus.OK) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(statusCode).send(xml);
}

function resolveBridgedSipUsername(record, endpoint) {
  return (
    endpoint?.username ||
    record?.providerResponse?.agentSipUsername ||
    ''
  );
}

/**
 * Build a normalized, fully-detailed summary of an inbound Plivo webhook for
 * structured logging. Captures every field useful for debugging a call.
 */
const webhookSummary = (eventType, body = {}) => {
  const pick = (...keys) => {
    for (const key of keys) {
      if (body[key] != null && body[key] !== '') return body[key];
    }
    return undefined;
  };
  return {
    event: eventType,
    callSid: pick('CallUUID', 'call_uuid'),
    parentCallSid: pick('ParentCallUUID', 'parent_call_uuid'),
    requestUuid: pick('RequestUUID', 'request_uuid'),
    callStatus: pick('CallStatus', 'Status', 'DialStatus', 'DialBLegStatus', 'Event'),
    hangupCause: pick('HangupCause', 'hangup_cause_name', 'DialBLegHangupCause', 'DialHangupCause'),
    hangupSource: pick('HangupSource', 'hangup_source', 'DialBLegHangupSource'),
    direction: pick('Direction', 'direction', 'CallDirection', 'call_direction'),
    duration: pick('Duration', 'BillDuration', 'CallDuration', 'bill_duration', 'duration'),
    to: pick('To', 'to_number', 'DialBLegTo'),
    from: pick('From', 'from_number'),
    recordingUrl: pick('RecordUrl', 'RecordingUrl', 'recording_url'),
    recordingId: pick('RecordingID', 'RecordingId', 'recording_id'),
  };
};

/** Log webhook summary for every inbound Plivo call webhook. */
const logCallWebhookReceived = (eventType, req) => {
  const payload = { ...(req.query || {}), ...(req.body || {}) };
  const summary = webhookSummary(eventType, payload);
  callEventLog.info(`webhook.${eventType}.received`, {
    method: req.method,
    path: req.originalUrl,
    ...summary,
  });
  return payload;
};

const makeCall = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  callEventLog.info('api.make_call', { userId, mode: req.body?.mode, hasContactId: Boolean(req.body?.contactId) });
  const result = await callService.makeCall(userId, req.body);
  res.status(httpStatus.OK).send({
    success: true,
    call: result.call,
    credentials: result.credentials || undefined,
    clientMode: result.clientMode ?? false,
    bridgedDial: result.bridgedDial ?? false,
    sdkOutbound: result.sdkOutbound ?? false,
    sdkWebRtc: result.sdkWebRtc ?? Boolean(result.clientMode),
    dialTarget: result.dialTarget || undefined,
    message: result.clientMode
      ? result.bridgedDial
        ? 'SDK WebRTC bridge call started — answer incoming leg when destination picks up'
        : result.sdkOutbound
          ? 'SDK WebRTC call session ready — place outbound call from app'
          : 'Client call session created'
      : 'Call initiated successfully',
  });
});

const registerClientCall = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  callEventLog.info('api.register_client_call', {
    userId,
    callId: req.body?.callId,
    callSid: req.body?.callSid,
  });
  const isAdmin = await userIsAdmin(req.user || {});
  const record = await callService.registerClientCall(userId, req.body, isAdmin);
  res.status(httpStatus.OK).send({
    success: true,
    call: record,
    message: 'Client call registered',
  });
});

const dialServerLeg = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const force = req.query?.force === 'true' || req.query?.force === '1';
  const bridged = req.query?.bridged !== 'false' && req.query?.bridged !== '0';
  callEventLog.info('api.server_dial', { userId, callId: req.params.id, force, bridged });
  const isAdmin = await userIsAdmin(req.user || {});
  const record = await callService.dialServerLeg(userId, req.params.id, isAdmin, { force, bridged });
  res.status(httpStatus.OK).send({
    success: true,
    call: record,
    clientMode: record.mode === 'client',
    bridgedDial: Boolean(record.providerResponse?.bridgedClientDial),
    message: record.providerResponse?.bridgedClientDial
      ? 'PSTN dial initiated; SDK will receive bridged audio leg'
      : 'PSTN dial initiated via server',
  });
});

const getCallStatus = catchAsync(async (req, res) => {
  const isAdmin = await userIsAdmin(req.user || {});
  const call = await callService.getCallStatus(
    getUserId(req),
    req.params.id,
    {
      sync: req.query.sync === 'true' || req.query.sync === '1',
      plivoSid: req.query.plivoSid || req.query.plivo_sid || undefined,
    },
    isAdmin
  );
  res.status(httpStatus.OK).send({ success: true, call });
});

const setMute = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const muted = req.body?.muted === true || req.body?.muted === 'true';
  callEventLog.info('api.set_mute', { userId, callId: req.params.id, muted });
  const isAdmin = await userIsAdmin(req.user || {});
  const record = await callService.setCallMuted(userId, req.params.id, muted, isAdmin);
  res.status(httpStatus.OK).send({
    success: true,
    call: record,
    message: muted ? 'Call muted' : 'Call unmuted',
  });
});

const setRecording = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  const recording = req.body?.recording === true || req.body?.recording === 'true';
  callEventLog.info('api.set_recording', { userId, callId: req.params.id, recording });
  const isAdmin = await userIsAdmin(req.user || {});
  const record = await callService.setCallRecording(userId, req.params.id, recording, isAdmin);
  res.status(httpStatus.OK).send({
    success: true,
    call: record,
    message: recording ? 'Recording started' : 'Recording stopped',
  });
});

const endCall = catchAsync(async (req, res) => {
  const userId = getUserId(req);
  callEventLog.info('api.end_call', { userId, callSid: req.params.callSid });
  const isAdmin = await userIsAdmin(req.user || {});
  const record = await callService.endCall(userId, req.params.callSid, isAdmin);
  res.status(httpStatus.OK).send({
    success: true,
    call: record,
    message: 'Call ended',
  });
});

const getCallDetails = catchAsync(async (req, res) => {
  const isAdmin = await userIsAdmin(req.user || {});
  const call = await callService.getCallById(getUserId(req), req.params.id, isAdmin);
  res.status(httpStatus.OK).send({ success: true, call });
});

const listCallHistory = catchAsync(async (req, res) => {
  const isAdmin = await userIsAdmin(req.user || {});
  const data = await callService.listCallHistory(getUserId(req), req.query, isAdmin);
  res.status(httpStatus.OK).send({ success: true, ...data });
});

const listRecordings = catchAsync(async (req, res) => {
  const isAdmin = await userIsAdmin(req.user || {});
  const data = await callService.listRecordings(getUserId(req), req.query, isAdmin);
  res.status(httpStatus.OK).send({ success: true, ...data });
});

const getRecording = catchAsync(async (req, res) => {
  const isAdmin = await userIsAdmin(req.user || {});
  const recording = await callService.getRecordingById(getUserId(req), req.params.id, isAdmin);
  res.status(httpStatus.OK).send({ success: true, recording });
});

const listReports = catchAsync(async (req, res) => {
  const isAdmin = await userIsAdmin(req.user || {});
  const data = await callService.listReports(getUserId(req), req.query, isAdmin);
  res.status(httpStatus.OK).send({ success: true, ...data });
});

const exportReports = catchAsync(async (req, res) => {
  const isAdmin = await userIsAdmin(req.user || {});
  const csv = await callService.exportReports(getUserId(req), req.query, isAdmin);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="call-reports.csv"');
  res.status(httpStatus.OK).send(csv);
});

const outboundAnswerXml = catchAsync(async (req, res) => {
  try {
    const payload = logCallWebhookReceived('answer-xml', req);
    const from = String(payload.From || payload.from || '');

    if (req.query?.fallback === 'hold') {
      return sendPlivoXml(res, plivoService.buildFallbackHoldAnswerXml());
    }

    const callUuid = payload.CallUUID || payload.call_uuid;

    const bridgeCallId =
      req.query?.callId ||
      req.query?.call_id ||
      payload.callId ||
      payload.call_id ||
      '';
    const bridgeMode =
      req.query?.bridge === 'sip' ||
      payload.bridge === 'sip' ||
      String(req.query?.bridge || payload.bridge || '').toLowerCase() === 'sip';

    if (bridgeMode && bridgeCallId) {
      const record = await Call.findById(String(bridgeCallId)).lean();
      const endpoint = record?.user
        ? await SipEndpoint.findOne({ user: record.user }).lean()
        : null;
      const sipUsername = resolveBridgedSipUsername(record, endpoint);
      const retry = Math.max(0, Number.parseInt(String(req.query?.retry || '0'), 10) || 0);

      if (!sipUsername) {
        callEventLog.error('webhook.bridged_answer_xml.missing_endpoint', {
          callId: String(bridgeCallId),
          callUUID: callUuid || '(none)',
        });
        return sendPlivoXml(
          res,
          plivoService.buildAnswerHangupXml('Unable to connect to the caller. Please try again.'),
        );
      }

      if (record?.user) {
        const registration = await endpointService.isEndpointRegistered(record.user);
        if (!registration.registered) {
          callEventLog.info('webhook.bridged_answer_xml.wait_for_registration', {
            callId: String(bridgeCallId),
            callUUID: callUuid || '(none)',
            sipUsername,
            retry,
            registrationError: registration.error || undefined,
          });
          return sendPlivoXml(
            res,
            plivoService.buildBridgedWaitXml(String(bridgeCallId), retry),
          );
        }
      }

      callEventLog.info('webhook.bridged_answer_xml', {
        callId: String(bridgeCallId),
        callUUID: callUuid || '(none)',
        sipUsername,
        to: record?.receiverNumber || '(unknown)',
        bridged: true,
        retry,
      });

      return sendPlivoXml(
        res,
        plivoService.buildBridgedPstnToSdkAnswerXml({
          sipUsername,
          callerId: record?.callerNumber || plivoService.getConfig().phoneNumber || from,
        }),
      );
    }

    // Legacy client (SIP) leg — bridge the SDK leg to its PSTN destination.
    const fromUsername = extractSipUsernameFromPlivoFrom(from);
    const isClientLeg =
      from.includes('sip:') ||
      from.includes('@phone.plivo.com') ||
      Boolean(fromUsername);
    if (isClientLeg) {
      const callId =
        payload['X-PH-DharwinCallId'] ||
        payload['X-PH-Dharwin-Call-Id'] ||
        payload['X-PH-dharwincallid'] ||
        '';
      const endpoint = fromUsername
        ? await SipEndpoint.findOne({ username: fromUsername }).lean()
        : null;

      if (!endpoint && !callId && !bridgeCallId) {
        callEventLog.warn('webhook.client_answer_xml.unknown_endpoint', {
          from,
          callUUID: callUuid || '(none)',
        });
        return sendPlivoXml(res, plivoService.buildAnswerHangupXml());
      }

      if (endpoint?.user && !callId && !bridgeCallId) {
        const activeBridged = await Call.findOne({
          user: endpoint.user,
          mode: 'client',
          direction: 'outbound',
          status: { $in: ['initiated', 'ringing', 'in_progress'] },
          $or: [
            { 'providerResponse.pstnBridgedDial': true },
            { 'providerResponse.bridgedClientDial': true },
          ],
        })
          .sort({ createdAt: -1 })
          .lean();

        if (activeBridged) {
          callEventLog.info('webhook.client_answer_xml.active_bridged_outbound', {
            callId: activeBridged._id?.toString(),
            callUUID: callUuid || '(none)',
            fromUsername,
          });
          if (callUuid) {
            void callSyncService
              .linkClientLegToCall({
                callId: activeBridged._id?.toString(),
                callUuid,
                from,
                to: payload.To || payload.to || '',
              })
              .catch((err) => {
                callEventLog.warn('webhook.client_answer_xml.bridged_link_failed', {
                  callId: activeBridged._id?.toString(),
                  callSid: callUuid,
                  error: err?.message,
                });
              });
          }
          return sendPlivoXml(res, plivoService.buildBridgedSdkLegAnswerXml());
        }
      }

      const callerIdHeader =
        payload['X-PH-callerId'] ||
        payload['X-PH-callerid'] ||
        payload['X-PH-CallerId'] ||
        '';
      let to =
        payload.dest ||
        payload['X-PH-Dest'] ||
        payload['X-PH-dest'] ||
        payload.To ||
        payload.to ||
        payload.DialBLegTo ||
        '';
      let sipUsername = '';
      const parentCallUuid = payload.ParentCallUUID || payload.parent_call_uuid || '';
      const callRecord = await callSyncService.resolveClientLegCallRecord({
        callId,
        callUUID: callUuid,
        parentCallUUID: parentCallUuid,
        from,
      });

      if (callSyncService.isPstnBridgedClientCall(callRecord)) {
        callEventLog.info('webhook.client_answer_xml.bridged_sdk_leg', {
          callId: callRecord?._id?.toString() || callId || '(none)',
          callUUID: callUuid || '(none)',
          parentCallUUID: parentCallUuid || '(none)',
          from,
        });

        if (callUuid) {
          void callSyncService
            .linkClientLegToCall({ callId: callRecord?._id?.toString() || callId, callUuid, from, to })
            .catch((err) => {
              callEventLog.warn('webhook.client_answer_xml.bridged_link_failed', {
                callId: callRecord?._id?.toString() || callId || '(none)',
                callSid: callUuid,
                error: err?.message,
              });
            });
        }

        return sendPlivoXml(res, plivoService.buildBridgedSdkLegAnswerXml());
      }

      const destination = await callSyncService.resolveClientAnswerDestination({
        callId,
        from,
        callUUID: callUuid,
      });
      if (!to) {
        to = destination.receiverNumber || '';
      }
      sipUsername = destination.sipUsername || '';

      if (destination.pstnBridged) {
        callEventLog.info('webhook.client_answer_xml.bridged_sdk_leg', {
          callId: callId || callRecord?._id?.toString() || '(none)',
          callUUID: callUuid || '(none)',
          from,
        });
        return sendPlivoXml(res, plivoService.buildBridgedSdkLegAnswerXml());
      }

      callEventLog.info('webhook.client_answer_xml', {
        to: to || '(missing)',
        sipUsername: sipUsername || '(none)',
        from,
        callId: callId || '(none)',
        callUUID: callUuid || '(none)',
      });

      if (callUuid) {
        void callSyncService
          .linkClientLegToCall({ callId, callUuid, from, to })
          .catch((err) => {
            callEventLog.warn('webhook.client_answer_xml.link_failed', {
              callId: callId || '(none)',
              callSid: callUuid,
              error: err?.message,
            });
          });
      }

      if (!to && !sipUsername) {
        callEventLog.error('webhook.client_answer_xml.missing_destination', {
          callId: callId || '(none)',
          callUUID: callUuid || '(none)',
          from,
        });
        return sendPlivoXml(res, plivoService.buildAnswerHangupXml());
      }

      return sendPlivoXml(
        res,
        plivoService.buildClientAnswerXml({
          to,
          sipUsername,
          callerId: callerIdHeader || plivoService.getConfig().phoneNumber || from,
        }),
      );
    }

    // Server-direct mode: record the call and hold the line. The destination has
    // answered, so flip to in_progress for real-time UI sync.
    if (callUuid) {
      void callSyncService
        .applyCallStatusWebhook({ ...payload, CallStatus: 'in-progress' })
        .catch((err) => {
          callEventLog.warn('webhook.outbound_answer_xml.status_update_failed', {
            callSid: callUuid,
            error: err?.message,
          });
        });
    }

    return sendPlivoXml(res, plivoService.buildOutboundAnswerXml());
  } catch (err) {
    callEventLog.error(
      'webhook.answer_xml.failed',
      {
        method: req.method,
        path: req.originalUrl,
        error: err?.message,
      },
      err?.stack,
    );
    return sendPlivoXml(res, plivoService.buildAnswerHangupXml());
  }
});

const receiveCallRingWebhook = catchAsync(async (req, res) => {
  const payload = logCallWebhookReceived('ring', req);
  callEventLog.info('webhook.ring.received', webhookSummary('ringing', payload));
  await callSyncService.applyCallStatusWebhook({ ...payload, CallStatus: 'ringing' });
  res.status(httpStatus.OK).send({ success: true });
});

const receiveCallStatusWebhook = catchAsync(async (req, res) => {
  const payload = logCallWebhookReceived('call-status', req);
  callEventLog.info('webhook.status.received', webhookSummary('call-status', payload));
  await callSyncService.applyCallStatusWebhook(payload);
  res.status(httpStatus.OK).send({ success: true });
});

const receiveDialStatusWebhook = catchAsync(async (req, res) => {
  try {
    const payload = logCallWebhookReceived('dial-status', req);
    const summary = webhookSummary('dial-status', payload);
    const dialStatus = String(
      payload.DialStatus || payload.DialBLegStatus || '',
    ).toLowerCase();
    const hangupCause = String(
      payload.DialHangupCause ||
        payload.DialBLegHangupCause ||
        summary.hangupCause ||
        '',
    ).toUpperCase();
    const failedDial =
      (dialStatus &&
        !['completed', 'answer', 'answered', 'in-progress', 'in_progress'].includes(dialStatus)) ||
      hangupCause === 'ORIGINATOR_CANCEL';

    let record = null;
    if (failedDial) {
      const callUuid = payload.CallUUID || payload.call_uuid;
      if (callUuid) {
        record = await callSyncService.findCallByUuid(String(callUuid));
      }
      if (!record) {
        record = await callSyncService.findCallByPayload(payload);
      }
    }

    const callId = record?._id?.toString();
    const isBridged = Boolean(
      record?.providerResponse?.bridgedClientDial || record?.providerResponse?.pstnBridgedDial,
    );
    const willRetryBridged = Boolean(failedDial && callId && isBridged);

    if (failedDial) {
      callEventLog.error('webhook.dial_status.failed', {
        ...summary,
        dialStatus,
        hangupCause,
        willRetryBridged,
        callId: callId || undefined,
      });
    } else {
      callEventLog.info('webhook.dial_status.received', summary);
    }

    if (willRetryBridged) {
      callEventLog.info('webhook.dial_status.bridged_retry', {
        callId,
        dialStatus,
        hangupCause,
      });
      await callSyncService.applyCallStatusWebhook({
        ...payload,
        DialStatus: 'ringing',
        CallStatus: 'ringing',
      });
      const xml = plivoService.buildBridgedDialRetryXml(callId);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(httpStatus.OK).send(xml);
    }

    await callSyncService.applyCallStatusWebhook(payload);

    const xml = plivoService.buildEmptyResponseXml();
    res.setHeader('Content-Type', 'text/xml');
    return res.status(httpStatus.OK).send(xml);
  } catch (err) {
    callEventLog.error(
      'webhook.dial_status.error',
      { error: err?.message },
      err?.stack,
    );
    res.setHeader('Content-Type', 'text/xml');
    return res.status(httpStatus.OK).send(plivoService.buildEmptyResponseXml());
  }
});

const receiveRecordingWebhook = catchAsync(async (req, res) => {
  const payload = logCallWebhookReceived('recording', req);
  callEventLog.info('webhook.recording.received', webhookSummary('recording', payload));
  await callSyncService.applyRecordingWebhook(payload);
  res.status(httpStatus.OK).send({ success: true });
});

export {
  makeCall,
  registerClientCall,
  dialServerLeg,
  setMute,
  setRecording,
  endCall,
  getCallDetails,
  getCallStatus,
  listCallHistory,
  listRecordings,
  getRecording,
  listReports,
  exportReports,
  outboundAnswerXml,
  receiveCallRingWebhook,
  receiveCallStatusWebhook,
  receiveDialStatusWebhook,
  receiveRecordingWebhook,
};
