/**
 * Phone-number catalogue + ownership.
 *
 * Numbers are searched and purchased via Twilio, then persisted to MongoDB
 * (`twiliophonenumbers`). A user can own many numbers; one org-default number is
 * shared. Caller-id resolution for outbound calls reads from here.
 */

import httpStatus from 'http-status';
import TwilioNumber from '../models/twilioNumber.model.js';
import twilioService from './twilio.service.js';
import config from '../config/config.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

/** Search purchasable numbers (Twilio catalogue, not yet owned). */
async function search(params) {
  const result = await twilioService.searchAvailableNumbers(params);
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to search numbers');
  }
  return result.numbers;
}

/** Purchase a number for a user and persist it. */
async function purchase(userId, params) {
  const phoneNumber = twilioService.toE164(params.phoneNumber);
  if (!phoneNumber) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'A valid phoneNumber (E.164) is required.');
  }

  const existing = await TwilioNumber.findOne({ phoneNumber, status: 'active' });
  if (existing) {
    throw new ApiError(httpStatus.CONFLICT, 'That number is already provisioned.');
  }

  const result = await twilioService.purchaseNumber(params);
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to purchase number');
  }

  const doc = await TwilioNumber.create({
    user: userId,
    isOrgDefault: false,
    phoneNumber: result.number.phoneNumber,
    sid: result.number.sid,
    friendlyName: result.number.friendlyName || '',
    capabilities: result.number.capabilities || {},
    voiceUrl: result.number.voiceUrl || '',
    status: 'active',
    providerResponse: result.providerResponse || {},
  });

  logger.info(`[Twilio] Number ${doc.phoneNumber} purchased for user ${userId}`);
  return doc;
}

/** List the numbers a user can use (their own + org default). */
async function listForUser(userId, { page = 1, limit = 50 } = {}) {
  const filter = {
    status: 'active',
    $or: [{ user: userId }, { isOrgDefault: true }],
  };
  return TwilioNumber.paginate(filter, { page, limit, sortBy: 'createdAt:desc' });
}

/** Resolve the caller-id to use for an outbound call. */
async function resolveCallerId(userId, requestedNumber) {
  const requested = twilioService.toE164(requestedNumber);
  if (requested) {
    const owned = await TwilioNumber.findOne({
      phoneNumber: requested,
      status: 'active',
      $or: [{ user: userId }, { isOrgDefault: true }],
    });
    if (owned) return owned.phoneNumber;
  }

  const orgDefault = await TwilioNumber.findOne({ isOrgDefault: true, status: 'active' });
  if (orgDefault) return orgDefault.phoneNumber;

  return config.twilio.phoneNumber || '';
}

/** Find which user owns an inbound number (for inbound routing). */
async function findOwnerByNumber(phoneNumber) {
  const e164 = twilioService.toE164(phoneNumber);
  if (!e164) return null;
  const record = await TwilioNumber.findOne({ phoneNumber: e164, status: 'active' });
  return record;
}

/** Release a number the user owns. */
async function release(userId, sid, { isAdmin = false } = {}) {
  const filter = isAdmin ? { sid } : { sid, user: userId };
  const record = await TwilioNumber.findOne(filter);
  if (!record) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Number not found.');
  }

  const result = await twilioService.releaseNumber(sid);
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to release number');
  }

  record.status = 'released';
  record.releasedAt = new Date();
  await record.save();
  return record;
}

export default {
  search,
  purchase,
  listForUser,
  resolveCallerId,
  findOwnerByNumber,
  release,
};
