import logger from '../config/logger.js';

function serializeError(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  if (typeof error === 'object') return error;
  return { message: String(error) };
}

function buildEntry(event, context = {}, error) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...context,
  };
  const serialized = serializeError(error);
  if (serialized !== undefined) {
    entry.error = serialized;
  }
  return entry;
}

function log(level, event, context = {}, error) {
  const entry = buildEntry(event, context, error);
  const line = `[Call] ${event} ${JSON.stringify(entry)}`;
  if (level === 'error') {
    logger.error(line);
  } else if (level === 'warn') {
    logger.warn(line);
  } else if (level === 'debug') {
    logger.debug(line);
  } else {
    logger.info(line);
  }
}

function logStateTransition(event, previousState, nextState, context = {}) {
  log('info', event, {
    previousState,
    nextState,
    callState: nextState,
    ...context,
  });
}

export default {
  info: (event, context) => log('info', event, context),
  warn: (event, context, error) => log('warn', event, context, error),
  error: (event, context, error) => log('error', event, context, error),
  debug: (event, context) => log('debug', event, context),
  stateTransition: logStateTransition,
};
