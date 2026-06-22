import Joi from 'joi';
import { objectId } from './custom.validation.js';

const createContact = {
  body: Joi.object()
    .keys({
      name: Joi.string().required().trim().min(1).max(120),
      phone: Joi.string().required().trim().min(7).max(20),
      secondaryPhone: Joi.string().trim().allow('').max(20),
      description: Joi.string().trim().allow('').max(500),
      email: Joi.string().trim().email().allow(''),
    })
    .required(),
};

const updateContact = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim().min(1).max(120),
      phone: Joi.string().trim().min(7).max(20),
      secondaryPhone: Joi.string().trim().allow('').max(20),
      description: Joi.string().trim().allow('').max(500),
      email: Joi.string().trim().email().allow(''),
    })
    .min(1),
};

const getContact = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

const deleteContact = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

const listContacts = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(500),
    search: Joi.string().trim().allow(''),
    sortBy: Joi.string().valid('name', 'createdAt').default('createdAt'),
  }),
};

export { createContact, updateContact, getContact, deleteContact, listContacts };
