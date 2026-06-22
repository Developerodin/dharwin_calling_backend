import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';

const PERMISSION_ALIASES = {
  'calls.read': ['calls.read', 'calls.manage'],
  'calls.manage': ['calls.manage'],
};

/**
 * Lightweight permission gate for calling APIs.
 * Admins bypass checks. When JWT includes a permissions array, enforce it.
 */
const requirePermissions = (...required) => (req, res, next) => {
  if (!req.user) {
    return next(new Error('auth middleware required before requirePermissions'));
  }

  if (req.user.platformSuperUser || req.user.isAdmin) {
    return next();
  }

  const tokenPermissions = Array.isArray(req.user.permissions) ? req.user.permissions : null;
  if (!tokenPermissions) {
    return next();
  }

  const granted = new Set(tokenPermissions);
  const allowed = required.some((permission) => {
    const aliases = PERMISSION_ALIASES[permission] || [permission];
    return aliases.some((alias) => granted.has(alias));
  });

  if (!allowed) {
    return next(new ApiError(httpStatus.FORBIDDEN, 'Insufficient permissions'));
  }

  return next();
};

export default requirePermissions;
