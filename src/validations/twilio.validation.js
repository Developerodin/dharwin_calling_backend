import Joi from 'joi';

const getAccessToken = {
  query: Joi.object().keys({
    platform: Joi.string().valid('ios', 'android').optional(),
  }),
};

const searchNumbers = {
  query: Joi.object().keys({
    country: Joi.string().trim().uppercase().length(2).default('US'),
    areaCode: Joi.number().integer().min(100).max(999),
    contains: Joi.string().trim().max(20),
    type: Joi.string().valid('local', 'mobile', 'tollFree').default('local'),
    limit: Joi.number().integer().min(1).max(30).default(20),
  }),
};

const purchaseNumber = {
  body: Joi.object()
    .keys({
      phoneNumber: Joi.string().required().trim().min(8).max(20),
      friendlyName: Joi.string().trim().max(120).allow(''),
    })
    .required(),
};

const listNumbers = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(200),
  }),
};

const releaseNumber = {
  params: Joi.object().keys({
    sid: Joi.string().required().trim(),
  }),
};

export { getAccessToken, searchNumbers, purchaseNumber, listNumbers, releaseNumber };
