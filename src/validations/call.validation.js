import Joi from 'joi';
import { objectId } from './custom.validation.js';

const makeCall = {
  body: Joi.object()
    .keys({
      to: Joi.string().trim(),
      from: Joi.string().trim(),
      registerPhone: Joi.string().trim(),
      contactId: Joi.string().custom(objectId),
      mode: Joi.string().valid('client', 'server').default('client'),
    })
    .or('to', 'contactId')
    .required(),
};

const setMute = {
  params: Joi.object().keys({
    id: Joi.string().required().trim(),
  }),
  body: Joi.object().keys({
    muted: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false')).required(),
  }),
};

const setRecording = {
  params: Joi.object().keys({
    id: Joi.string().required().trim(),
  }),
  body: Joi.object().keys({
    recording: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false')).required(),
  }),
};

const registerClientCall = {
  body: Joi.object()
    .keys({
      callId: Joi.string().custom(objectId).required(),
      callSid: Joi.string().required().trim(),
    })
    .required(),
};

const dialServerLeg = {
  params: Joi.object().keys({
    id: Joi.string().required().trim(),
  }),
};

const getCallStatus = {
  params: Joi.object().keys({
    id: Joi.string().required().trim(),
  }),
  query: Joi.object().keys({
    sync: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('true', 'false', '1', '0')),
    plivoSid: Joi.string().trim(),
    plivo_sid: Joi.string().trim(),
  }),
};

const endCall = {
  params: Joi.object().keys({
    callSid: Joi.string().required().trim(),
  }),
};

const getCallDetails = {
  params: Joi.object().keys({
    id: Joi.string().required().trim(),
  }),
};

const listCallHistory = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(500),
    search: Joi.string().trim().allow(''),
    status: Joi.string().trim().allow(''),
    contactId: Joi.string().custom(objectId),
    fromDate: Joi.date().iso(),
    toDate: Joi.date().iso(),
    order: Joi.string().valid('asc', 'desc').default('desc'),
  }),
};

const listRecordings = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(500),
    callSid: Joi.string().trim().allow(''),
    status: Joi.string().trim().allow(''),
  }),
};

const getRecording = {
  params: Joi.object().keys({
    id: Joi.string().required().trim(),
  }),
};

const listReports = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(500),
    search: Joi.string().trim().allow(''),
    status: Joi.string().trim().allow(''),
    contactId: Joi.string().custom(objectId),
    fromDate: Joi.date().iso(),
    toDate: Joi.date().iso(),
  }),
};

const exportReports = {
  query: Joi.object().keys({
    search: Joi.string().trim().allow(''),
    status: Joi.string().trim().allow(''),
    contactId: Joi.string().custom(objectId),
    fromDate: Joi.date().iso(),
    toDate: Joi.date().iso(),
  }),
};

export {
  makeCall,
  registerClientCall,
  dialServerLeg,
  setMute,
  setRecording,
  getCallStatus,
  endCall,
  getCallDetails,
  listCallHistory,
  listRecordings,
  getRecording,
  listReports,
  exportReports,
};
