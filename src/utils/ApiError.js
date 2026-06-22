class ApiError extends Error {
  constructor(statusCode, message, isOperational = true, stack = '', extras = {}) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.stack = stack || Error.captureStackTrace(this, this.constructor);
    // Backwards-compatible 5th positional: callers may pass either an object
    // (legacy `extras` with subCode/details/errorCode) or an Array of structured
    // per-row / per-field error entries (e.g. bulk Excel import validation).
    if (Array.isArray(extras)) {
      /** Structured per-row / per-field error entries */
      this.errors = extras;
    } else if (extras && typeof extras === 'object') {
      /** Client hint e.g. outlook_reauth_required */
      if (extras.subCode) this.subCode = extras.subCode;
      if (extras.details) this.details = extras.details;
      /** Stable code for client UI e.g. CANDIDATE_RESIGNED */
      if (extras.errorCode) this.errorCode = extras.errorCode;
      if (Array.isArray(extras.errors)) this.errors = extras.errors;
    }
  }
}

export default ApiError;
