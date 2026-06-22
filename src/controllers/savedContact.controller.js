import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import savedContactService from '../services/savedContact.service.js';

const getUserId = (req) => req.user?.id || req.user?._id;

const createContact = catchAsync(async (req, res) => {
  const contact = await savedContactService.createContact(getUserId(req), req.body);
  res.status(httpStatus.CREATED).send({ success: true, contact });
});

const listContacts = catchAsync(async (req, res) => {
  const data = await savedContactService.listContacts(getUserId(req), req.query);
  res.status(httpStatus.OK).send({
    success: true,
    results: data.results,
    page: data.page,
    limit: data.limit,
    total: data.totalResults,
    totalPages: data.totalPages,
  });
});

const getContact = catchAsync(async (req, res) => {
  const contact = await savedContactService.getContactById(getUserId(req), req.params.id);
  res.status(httpStatus.OK).send({ success: true, contact });
});

const updateContact = catchAsync(async (req, res) => {
  const contact = await savedContactService.updateContact(getUserId(req), req.params.id, req.body);
  res.status(httpStatus.OK).send({ success: true, contact });
});

const deleteContact = catchAsync(async (req, res) => {
  await savedContactService.deleteContact(getUserId(req), req.params.id);
  res.status(httpStatus.OK).send({ success: true, message: 'Contact deleted' });
});

export { createContact, listContacts, getContact, updateContact, deleteContact };
