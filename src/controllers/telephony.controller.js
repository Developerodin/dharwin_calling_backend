import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import endpointService from '../services/endpoint.service.js';
import plivoService from '../services/plivo.service.js';

const getUserId = (req) => req.user?.id || req.user?._id;

const getCredentials = catchAsync(async (req, res) => {
  if (!plivoService.isConfigured()) {
    return res.status(httpStatus.SERVICE_UNAVAILABLE).send({
      success: false,
      message: 'Plivo is not configured on the server.',
    });
  }

  const userId = getUserId(req);
  const registerPhone = req.body?.phoneNumber || req.query?.phoneNumber;
  if (registerPhone) {
    await endpointService.updateEndpointPhone(userId, String(registerPhone));
  }

  const rotateCredentials = req.query?.rotate === 'true' || req.query?.rotate === '1';
  const credentials = await endpointService.getCredentialsForUser(userId, {
    rotateCredentials,
  });
  res.status(httpStatus.OK).send({
    success: true,
    credentials,
  });
});

const registerPhone = catchAsync(async (req, res) => {
  if (!plivoService.isConfigured()) {
    return res.status(httpStatus.SERVICE_UNAVAILABLE).send({
      success: false,
      message: 'Plivo is not configured on the server.',
    });
  }

  const phoneNumber = String(req.body?.phoneNumber || '').trim();
  if (!phoneNumber) {
    return res.status(httpStatus.BAD_REQUEST).send({
      success: false,
      message: 'phoneNumber is required',
    });
  }

  const endpoint = await endpointService.updateEndpointPhone(getUserId(req), phoneNumber);
  res.status(httpStatus.OK).send({
    success: true,
    phoneNumber: endpoint?.phoneNumber || phoneNumber,
  });
});

const getRegistrationStatus = catchAsync(async (req, res) => {
  if (!plivoService.isConfigured()) {
    return res.status(httpStatus.SERVICE_UNAVAILABLE).send({
      success: false,
      message: 'Plivo is not configured on the server.',
    });
  }

  const status = await endpointService.isEndpointRegistered(getUserId(req));
  res.status(httpStatus.OK).send({
    success: true,
    ...status,
  });
});

export { getCredentials, registerPhone, getRegistrationStatus };
