# Dharwin Calling Backend — Reference

> Dedicated microservice for PSTN voice calling via **Plivo**, with real-time call-status updates over **Socket.IO** and a contact-management layer. Validates the **same JWT secret** as the main `dharwinone_backend`, so access tokens are reused across services.

Last mapped: 2026-06-22. Update this file when routes, events, env vars, or models change.

---

## 1. Quick Facts

| Aspect | Value |
|--------|-------|
| Language | JavaScript (Node.js ≥18, ES modules, `"type": "module"`) |
| Framework | Express.js 4.17.1 |
| Database | MongoDB via Mongoose 8.9.5 |
| Real-time | Socket.IO 4.8.3 (WebSocket + long-polling) |
| Calling provider | Plivo Voice API (`plivo` SDK v4.78.0) |
| Auth | JWT Bearer, shared `JWT_SECRET` with main backend |
| Entry point | `src/index.js` |
| Express app | `src/app.js` |
| Port | `3001` (env `PORT`) |
| API prefix | `/v1` |
| Socket path | `/socket.io` |

**Key deps:** `plivo`, `socket.io`, `jsonwebtoken`, `joi`, `mongoose`, `winston`, `helmet`, `compression`, `cors`, `express-mongo-sanitize`, `http-status`.

---

## 2. Boot Sequence (`src/index.js`)

1. Load `.env` via dotenv.
2. Force DNS IPv4-first (stability with external APIs).
3. Connect MongoDB at `MONGODB_URL`.
4. `http.createServer(app)` — native HTTP server.
5. Init Socket.IO on the **same** HTTP server.
6. Listen on `0.0.0.0:PORT`.
7. Log Plivo webhook base URL config.

**Middleware stack (`src/app.js`):** Helmet → requestId → compression → CORS (dev: allow all; prod: `CORS_ORIGIN` whitelist) → JSON/urlencoded body parsers (with raw-body capture for webhook signature validation) → mongo-sanitize → routes at `/v1` → error handler.

---

## 3. API Routes (base `/v1`)

### Health
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/v1/health` | public | service status + Plivo config/webhook URLs |

### Calls — `src/routes/v1/call.route.js`
| Method | Path | Permission | Handler | Description |
|--------|------|-----------|---------|-------------|
| POST | `/v1/calls` | `calls.manage` | `makeCall` | Initiate outbound call (client/server mode); returns credentials + call record |
| GET | `/v1/calls` | `calls.read` | `listCallHistory` | Paginated history (status, date range, contact, search filters) |
| POST | `/v1/calls/register` | `calls.manage` | `registerClientCall` | Link Plivo call UUID to app-initiated call record |
| POST | `/v1/calls/:id/server-dial` | `calls.manage` | `dialServerLeg` | Dial PSTN leg for bridged SDK call |
| GET | `/v1/calls/:id` | `calls.read` | `getCallDetails` | Full call record (Mongo ID or call UUID) |
| GET | `/v1/calls/:id/status` | `calls.read` | `getCallStatus` | Live status; `?sync=true` polls Plivo API |
| POST | `/v1/calls/:id/mute` | `calls.manage` | `setMute` | Body `{ muted: bool }` |
| POST | `/v1/calls/:id/recording` | `calls.manage` | `setRecording` | Body `{ recording: bool }` |
| POST | `/v1/calls/:callSid/end` | `calls.manage` | `endCall` | Terminate via Plivo API |
| GET | `/v1/recordings` | `calls.read` | `listRecordings` | Paginated recordings |
| GET | `/v1/recordings/:id` | `calls.read` | `getRecording` | Recording metadata + URL |
| GET | `/v1/reports` | `calls.read` | `listReports` | Paginated CDR-like reports |
| GET | `/v1/reports/export` | `calls.read` | `exportReports` | CSV export |
| GET/POST | `/v1/xml/answer` | public* | `outboundAnswerXml` | Plivo Answer webhook → returns PlivoXML; handles bridging |

\* Signature-validated when `PLIVO_VERIFY_WEBHOOKS=true`.

### Telephony / SIP — `src/routes/v1/call.route.js`
| Method | Path | Permission | Handler | Description |
|--------|------|-----------|---------|-------------|
| GET | `/v1/telephony/credentials` | `calls.read` | `getCredentials` | SIP username/password for Plivo SDK login; auto-creates endpoint on first call |
| GET | `/v1/telephony/registration` | `calls.read` | `getRegistrationStatus` | Is SIP endpoint registered with Plivo? |
| PUT | `/v1/telephony/phone` | `calls.read` | `registerPhone` | Update endpoint phone number |

### Contacts — `src/routes/v1/contacts.route.js`
| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| GET | `/v1/contacts` | `calls.read` | List (paginated, per-user) |
| POST | `/v1/contacts` | `calls.manage` | Create (name, phone, secondaryPhone, email, description) |
| GET | `/v1/contacts/:id` | `calls.read` | Fetch one |
| PATCH | `/v1/contacts/:id` | `calls.manage` | Update |
| DELETE | `/v1/contacts/:id` | `calls.manage` | Delete |

### Webhooks (Plivo) — `src/routes/v1/webhook.route.js` (public, signature-validated)
| Method | Path | Event |
|--------|------|-------|
| POST | `/v1/webhooks/plivo-call-ring` | Call ringing |
| POST | `/v1/webhooks/plivo-call-status` | State change (answered/hangup/failed) |
| POST | `/v1/webhooks/plivo-dial-status` | B-leg dial progress |
| POST | `/v1/webhooks/plivo-recording` | Recording ready (URL + metadata) |

**Signature validation:** `X-Plivo-Signature-V3` + `X-Plivo-Signature-V3-Nonce` headers, middleware `src/middlewares/verifyPlivoWebhook.js`. Disable with `PLIVO_VERIFY_WEBHOOKS=false` (dev only). Behind proxy/ngrok, set `TRUST_PROXY_HOPS`.

---

## 4. Socket.IO Real-time

**Auth:** JWT from `handshake.auth.token` / `handshake.query.token` / `Authorization` header; same `JWT_SECRET`, expects `type: 'access'`. On connect, socket auto-joins room `user:<userId>`.

Config: path `/socket.io`, WS + polling, pingTimeout 25s, pingInterval 20s.

### Client → Server
| Event | Payload | Effect |
|-------|---------|--------|
| `join-call-room` | `{ callUUID }` (or `callUuid`/`callSid`) | Join room `call:<uuid>`; ACK `{ success, room }` |
| `leave-call-room` | `{ callUUID }` | Leave; ACK `{ success }` |
| `call:subscribe` | — | **Deprecated** alias of join-call-room |

### Server → Client (emitted to `user:<userId>` and `call:<uuid>`)
| Event | When |
|-------|------|
| `call-status-updated` | After every webhook DB write — full snapshot (status, duration, mute, recording, URLs) |
| `call:update` | **Deprecated** duplicate of above |
| `call:ended` | Terminal state only (completed/failed/busy/no_answer/canceled/rejected) |
| `recording-ready` | Recording webhook arrives with download URL |
| `call-history-updated` | Any status change — compact history payload |
| `incoming-phone-call` | Inbound PSTN routed to registered app user (SIP endpoint) |

Helpers in `src/socket/callBroadcast.js`: `emitToUser`, `emitToCallRoom`, serialize/snapshot builders. Setup in `src/socket/realtime.js`. Rooms cleaned up ~60s after terminal status.

---

## 5. Calling Model (Plivo)

**Modes:**
1. **Client (default):** per-user SIP endpoint → SDK WebRTC login → `client.call("+1...")`. Backend `/xml/answer` bridges SDK leg ↔ PSTN with recording. In-app audio; supports mute/recording.
2. **Server (fallback):** backend dials PSTN directly via REST; no in-app audio.
3. **Bridged client dial (hybrid):** SDK initiates A-leg; backend dials PSTN B-leg via `dialServerLeg`.

**Client-mode flow:**
```
POST /v1/calls {to,mode:client} → create Call(initiated) + fetch SIP creds
  → resp {call, credentials}
  → app logs into Plivo SDK, client.call(to)
  → Plivo A-leg(SDK)+B-leg(PSTN), fetches POST /v1/xml/answer
  → backend returns <Dial><SIP>...</SIP></Dial> (+<Record>)
  → webhooks (ring/answer/hangup) update DB → Socket.IO broadcast
```

**SIP credentials (`src/services/endpoint.service.js`):** per-user endpoint, stored in `plivosipendpoints`. Username `dharwin<suffix><hex>`, password base64url(18 bytes), alias `Dharwin<suffix>`. App auto-created (name `DharwinOne_Calling`) or uses `PLIVO_APP_ID`.

**Call statuses:** `initiated`/`queued` → `ringing` → `in_progress` → terminal: `completed`/`failed`/`busy`/`no_answer`/`canceled`/`rejected`.

**Recording:** auto-starts on PSTN answer (Answer XML `<Record>`), stops on hangup; webhook returns URL. Stored as `recordingUrl`/`recordingSid`/`recordingDuration`.

---

## 6. Folder Structure (`src/`)

```
src/
├── index.js                 # bootstrap: Mongo, HTTP server, Socket.IO
├── app.js                   # Express app + middleware chain
├── config/
│   ├── config.js            # Joi-validated env → config object
│   ├── logger.js            # Winston
│   └── tokens.js            # token-type constants
├── routes/v1/
│   ├── index.js             # mounts call, contacts, webhooks
│   ├── call.route.js        # calls + telephony endpoints
│   ├── contacts.route.js
│   └── webhook.route.js
├── controllers/             # call, telephony, savedContact
├── services/
│   ├── call.service.js      # core call logic
│   ├── callSync.service.js  # webhook event → DB sync + CallReport
│   ├── plivo.service.js     # Plivo SDK wrapper, XML builders, signature
│   ├── endpoint.service.js  # SIP endpoint lifecycle
│   └── savedContact.service.js
├── models/                  # call, callRecording, callReport, savedContact, sipEndpoint
│   └── plugins/             # toJSON, paginate
├── middlewares/             # auth, requirePermissions, validate, verifyPlivoWebhook, error, requestId
├── socket/                  # realtime.js, callBroadcast.js
├── validations/             # joi schemas: call, savedContact, custom
└── utils/                   # ApiError, authHelpers, callEventLog, catchAsync, phone, pick
```

---

## 7. Environment Variables (`.env`)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NODE_ENV` | yes | — | development / production / test |
| `PORT` | no | 3001 | HTTP port |
| `MONGODB_URL` | yes | — | Mongo connection (separate DB recommended) |
| `JWT_SECRET` | yes (≥32 chars) | — | **Must match main backend** |
| `CORS_ORIGIN` | no | '' | comma-separated whitelist (prod) |
| `BACKEND_PUBLIC_URL` | no | `http://localhost:3001` | public base URL; fallback for webhook base |
| `TRUST_PROXY_HOPS` | no | 0 | proxy hops (1 for ngrok/LB) |
| `PLIVO_AUTH_ID` | no* | '' | Plivo Auth ID |
| `PLIVO_AUTH_TOKEN` | no* | '' | Plivo Auth Token |
| `PLIVO_PHONE_NUMBER` | no* | '' | outbound caller ID (E.164) |
| `PLIVO_WEBHOOK_BASE_URL` | no | (→BACKEND_PUBLIC_URL) | public **HTTPS** base for webhooks/Answer XML (no `/v1` suffix) |
| `PLIVO_APP_ID` | no | '' | existing Plivo app (auto-created if omitted) |
| `PLIVO_VERIFY_WEBHOOKS` | no | prod: true / dev: false | validate Plivo V3 signatures |

\* required only if calling is enabled.

---

## 8. Database / Models

| Collection | Model | Key fields |
|------------|-------|-----------|
| `plivocalls` | call.model.js | `callSid`(uniq), user, contact, callerNumber, receiverNumber, status, direction, mode, muted, recordingActive, duration, callStart/EndTime, recordingUrl/Sid, errorMessage, providerResponse, source, reportGenerated |
| `plivocallrecordings` | callRecording.model.js | call(ref), user, callSid, recordingSid(uniq), recordingUrl, duration, status, channels, raw |
| `plivocallreports` | callReport.model.js | call(ref), user, contact, callSid(uniq), caller/receiverNumber, callDuration, callStatus, recordingUrl/Duration, start/end, generatedAt, providerResponse |
| `plivosipendpoints` | sipEndpoint.model.js | user(ref,uniq), username(uniq), password, endpointId, alias, phoneNumber, appId, providerResponse |
| `savedcontacts` | savedContact.model.js | user(ref), name, phone, secondaryPhone, description, email |

Run `npm run migrate:indexes` to ensure indexes in production.

---

## 9. Auth

JWT Bearer (stateless), middleware `src/middlewares/auth.js`. Expected payload:
```json
{ "sub": "userId", "type": "access", "isAdmin": false,
  "platformSuperUser": false, "permissions": ["calls.read","calls.manage"] }
```
Permissions (`src/middlewares/requirePermissions.js`):
- `calls.read` — view history/details/recordings/reports
- `calls.manage` — initiate/mute/record/end + manage contacts
- admins / platformSuperUsers bypass all checks.

Socket.IO uses the same validation.

---

## 10. Docs

- `docs/PLIVO.md` — Plivo API overview, webhooks, call flow, Twilio migration notes.
- `docs/PLIVO_SETUP.md` — end-to-end setup (architecture, env, mobile, curl examples, testing, troubleshooting).
- `README.md` — quick start, route summary, JWT note, migration command.

---

## 11. Common Change Recipes

- **New call endpoint:** add validation in `src/validations/call.validation.js` → handler in `src/controllers/call.controller.js` → logic in `src/services/call.service.js` → wire in `src/routes/v1/call.route.js` with `auth` + `requirePermissions`.
- **New socket event:** emit via helpers in `src/socket/callBroadcast.js`; register listeners in `src/socket/realtime.js`. Mirror to both `user:` and `call:` rooms.
- **New webhook:** add route in `webhook.route.js` (with `verifyPlivoWebhook`) → handler that calls `callSync.service.js` to normalize + persist + broadcast.
- **New collection:** model in `src/models/` (add `toJSON`/`paginate` plugins) → service → controller → route.
