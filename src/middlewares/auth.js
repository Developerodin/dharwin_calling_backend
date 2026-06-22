import jwt from 'jsonwebtoken';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { tokenTypes } from '../config/tokens.js';
import ApiError from '../utils/ApiError.js';

function extractBearerToken(req) {
  const header = req.get('authorization') || req.get('Authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * Validates access tokens issued by dharwinone_backend (same JWT_SECRET).
 */
const auth = () => (req, res, next) => {
  const token = extractBearerToken(req);
  if (!token) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    if (payload.type !== tokenTypes.ACCESS) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Invalid token type'));
    }

    const userId = payload.sub;
    req.user = {
      id: userId,
      _id: userId,
      platformSuperUser: Boolean(payload.platformSuperUser),
      isAdmin: Boolean(payload.isAdmin),
      permissions: Array.isArray(payload.permissions) ? payload.permissions : undefined,
    };
    return next();
  } catch {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }
};

export default auth;
