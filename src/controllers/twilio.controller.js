/**
 * Authenticated Twilio endpoints: Access Token vending + phone-number catalogue.
 */

import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import pick from '../utils/pick.js';
import twilioService from '../services/twilio.service.js';
import numberService from '../services/twilioNumber.service.js';

const getUserId = (req) => req.user?.id || req.user?._id;

/** GET /telephony/token — short-lived Access Token for the Voice SDK. */
const getAccessToken = catchAsync(async (req, res) => {
  if (!twilioService.isConfigured()) {
    return res.status(httpStatus.SERVICE_UNAVAILABLE).send({
      success: false,
      message: 'Twilio is not configured on the server.',
    });
  }

  const platform = String(req.query?.platform || '').toLowerCase();
  const result = twilioService.createAccessToken(getUserId(req), {
    platform: platform === 'ios' || platform === 'android' ? platform : undefined,
  });
  if (!result.success) {
    return res.status(httpStatus.SERVICE_UNAVAILABLE).send({ success: false, message: result.error });
  }

  res.status(httpStatus.OK).send({
    success: true,
    token: result.token,
    identity: result.identity,
    ttl: result.ttl,
  });
});

/** GET /numbers/available — search the Twilio catalogue. */
const searchNumbers = catchAsync(async (req, res) => {
  const params = pick(req.query, ['country', 'areaCode', 'contains', 'type', 'limit']);
  const numbers = await numberService.search(params);
  res.status(httpStatus.OK).send({ success: true, numbers });
});

/** POST /numbers/purchase — buy a number for the current user. */
const purchaseNumber = catchAsync(async (req, res) => {
  const body = pick(req.body, ['phoneNumber', 'friendlyName']);
  const number = await numberService.purchase(getUserId(req), body);
  res.status(httpStatus.CREATED).send({ success: true, number });
});

/** GET /numbers — list the user's numbers (own + org default). */
const listNumbers = catchAsync(async (req, res) => {
  const { page, limit } = pick(req.query, ['page', 'limit']);
  const result = await numberService.listForUser(getUserId(req), {
    page: page ? Number(page) : 1,
    limit: limit ? Number(limit) : 50,
  });
  res.status(httpStatus.OK).send({ success: true, ...result });
});

/** DELETE /numbers/:sid — release a number the user owns. */
const releaseNumber = catchAsync(async (req, res) => {
  const isAdmin = Boolean(req.user?.isAdmin || req.user?.platformSuperUser);
  const number = await numberService.release(getUserId(req), req.params.sid, { isAdmin });
  res.status(httpStatus.OK).send({ success: true, number });
});

export { getAccessToken, searchNumbers, purchaseNumber, listNumbers, releaseNumber };
