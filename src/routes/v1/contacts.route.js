import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as savedContactValidation from '../../validations/savedContact.validation.js';
import * as savedContactController from '../../controllers/savedContact.controller.js';

const router = express.Router();

router
  .route('/')
  .get(
    auth(),
    requirePermissions('calls.read'),
    validate(savedContactValidation.listContacts),
    savedContactController.listContacts
  )
  .post(
    auth(),
    requirePermissions('calls.manage'),
    validate(savedContactValidation.createContact),
    savedContactController.createContact
  );

router
  .route('/:id')
  .get(
    auth(),
    requirePermissions('calls.read'),
    validate(savedContactValidation.getContact),
    savedContactController.getContact
  )
  .patch(
    auth(),
    requirePermissions('calls.manage'),
    validate(savedContactValidation.updateContact),
    savedContactController.updateContact
  )
  .delete(
    auth(),
    requirePermissions('calls.manage'),
    validate(savedContactValidation.deleteContact),
    savedContactController.deleteContact
  );

export default router;
