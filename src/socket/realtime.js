/**
 * Socket.IO realtime layer for the calling backend.
 *
 * Responsibilities:
 *  - Authenticate socket connections with the same access JWT used by the REST API.
 *  - Place each connection into a per-user room (`user:<userId>`).
 *  - Allow clients to join call-specific rooms by Plivo Call UUID (`call:<callUUID>`).
 *  - Expose emit helpers used by the webhook/sync layer to push updates instantly.
 */

import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import config from '../config/config.js';
import { tokenTypes } from '../config/tokens.js';
import logger from '../config/logger.js';

let io = null;

/** Canonical event names (mobile app listens on these). */
export const CALL_EVENTS = {
  /** Primary real-time status payload after every webhook DB write. */
  statusUpdated: 'call-status-updated',
  /** Recording URL is available for a call. */
  recordingReady: 'recording-ready',
  /** Call history list should refresh or patch an entry. */
  historyUpdated: 'call-history-updated',
  /** Incoming Browser SDK phone call for a registered app user. */
  incomingPhoneCall: 'incoming-phone-call',
  /** @deprecated Use call-status-updated — kept for older app builds. */
  update: 'call:update',
  /** @deprecated Terminal convenience — call-status-updated is authoritative. */
  ended: 'call:ended',
};

/** Client → server subscription events. */
export const CLIENT_EVENTS = {
  joinCallRoom: 'join-call-room',
  leaveCallRoom: 'leave-call-room',
  /** @deprecated Use join-call-room */
  subscribe: 'call:subscribe',
};

function userRoom(userId) {
  return `user:${String(userId)}`;
}

export function callRoom(callUuid) {
  if (!callUuid) return null;
  return `call:${String(callUuid)}`;
}

function extractToken(socket) {
  const auth = socket.handshake?.auth || {};
  if (auth.token) return String(auth.token).replace(/^Bearer\s+/i, '').trim();

  const query = socket.handshake?.query || {};
  if (query.token) return String(query.token).replace(/^Bearer\s+/i, '').trim();

  const header = socket.handshake?.headers?.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();

  return null;
}

function authenticateSocket(socket, next) {
  const token = extractToken(socket);
  if (!token) {
    return next(new Error('Unauthorized: missing token'));
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    if (payload.type !== tokenTypes.ACCESS) {
      return next(new Error('Unauthorized: invalid token type'));
    }
    socket.data.userId = String(payload.sub);
    socket.data.platformSuperUser = Boolean(payload.platformSuperUser);
    socket.data.isAdmin = Boolean(payload.isAdmin);
    return next();
  } catch {
    return next(new Error('Unauthorized: invalid token'));
  }
}

function resolveCallUuidFromPayload(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload.trim() || null;
  const uuid =
    payload.callUUID ||
    payload.callUuid ||
    payload.callSid ||
    payload.callId ||
    payload.CallUUID;
  return uuid ? String(uuid) : null;
}

function joinSocketToCallRoom(socket, callUuid) {
  const room = callRoom(callUuid);
  if (!room) return null;
  socket.join(room);
  if (!socket.data.joinedCallRooms) socket.data.joinedCallRooms = new Set();
  socket.data.joinedCallRooms.add(room);
  logger.info(`[Socket] ${socket.id} joined ${room} (user ${socket.data.userId})`);
  return room;
}

function leaveSocketFromCallRoom(socket, callUuid) {
  const room = callRoom(callUuid);
  if (!room) return;
  socket.leave(room);
  socket.data.joinedCallRooms?.delete(room);
  logger.info(`[Socket] ${socket.id} left ${room}`);
}

/**
 * Initialise Socket.IO on top of the shared HTTP server.
 * @param {import('http').Server} httpServer
 */
export function initRealtime(httpServer) {
  if (io) return io;

  const corsOrigins =
    config.env === 'development'
      ? true
      : config.corsOrigin
        ? config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
        : true;

  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: corsOrigins, credentials: true },
    transports: ['websocket', 'polling'],
    pingTimeout: 25000,
    pingInterval: 20000,
  });

  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const { userId } = socket.data;
    socket.join(userRoom(userId));
    socket.data.joinedCallRooms = new Set();
    logger.info(`[Socket] connected ${socket.id} (user ${userId})`);

    const handleJoin = (payload, ack) => {
      const callUuid = resolveCallUuidFromPayload(payload);
      if (!callUuid) {
        if (typeof ack === 'function') ack({ success: false, error: 'callUUID is required' });
        return;
      }
      const room = joinSocketToCallRoom(socket, callUuid);
      if (typeof ack === 'function') ack({ success: true, room, callUUID: callUuid });
    };

    socket.on(CLIENT_EVENTS.joinCallRoom, handleJoin);
    socket.on(CLIENT_EVENTS.subscribe, (payload, ack) => {
      const callUuid =
        resolveCallUuidFromPayload(payload) ||
        (payload?.callId ? String(payload.callId) : null);
      handleJoin(callUuid ? { callUUID: callUuid } : payload, ack);
    });

    socket.on(CLIENT_EVENTS.leaveCallRoom, (payload, ack) => {
      const callUuid = resolveCallUuidFromPayload(payload);
      if (callUuid) leaveSocketFromCallRoom(socket, callUuid);
      if (typeof ack === 'function') ack({ success: true });
    });

    socket.on('disconnect', (reason) => {
      logger.info(`[Socket] disconnected ${socket.id} (user ${userId}): ${reason}`);
    });
  });

  logger.info('[Socket] realtime layer initialised');
  return io;
}

export function getIo() {
  return io;
}

/**
 * Count sockets in a room (for delivery logging).
 * @param {string} room
 */
async function countRoomSockets(room) {
  if (!io || !room) return 0;
  try {
    const sockets = await io.in(room).fetchSockets();
    return sockets.length;
  } catch {
    return -1;
  }
}

/**
 * Emit an event to every connected device for a given user.
 * @param {string} userId
 * @param {string} event
 * @param {unknown} payload
 */
export async function emitToUser(userId, event, payload) {
  if (!io || !userId) return 0;
  const room = userRoom(userId);
  io.to(room).emit(event, payload);
  const delivered = await countRoomSockets(room);
  logger.info(`[Socket] emitted ${event} → ${room} (${delivered} socket(s))`, {
    callUUID: payload?.callUUID || payload?.callSid,
    status: payload?.status,
  });
  return delivered;
}

/**
 * Emit an event to everyone subscribed to a specific Plivo Call UUID room.
 * @param {string} callUuid
 * @param {string} event
 * @param {unknown} payload
 */
export async function emitToCallRoom(callUuid, event, payload) {
  if (!io || !callUuid) return 0;
  const room = callRoom(callUuid);
  if (!room) return 0;
  io.to(room).emit(event, payload);
  const delivered = await countRoomSockets(room);
  logger.info(`[Socket] emitted ${event} → ${room} (${delivered} socket(s))`, {
    callUUID: callUuid,
    status: payload?.status,
  });
  return delivered;
}

/**
 * After a call reaches a terminal state, remove all sockets from the call room
 * so the room does not accumulate stale subscriptions.
 * @param {string} callUuid
 */
export function cleanupCallRoom(callUuid) {
  if (!io || !callUuid) return;
  const room = callRoom(callUuid);
  if (!room) return;
  // Delay slightly so in-flight events still reach subscribers.
  setTimeout(() => {
    io.in(room).socketsLeave(room);
    logger.info(`[Socket] cleaned up room ${room}`);
  }, 60_000);
}

export default {
  initRealtime,
  getIo,
  emitToUser,
  emitToCallRoom,
  cleanupCallRoom,
  callRoom,
  CALL_EVENTS,
  CLIENT_EVENTS,
};
