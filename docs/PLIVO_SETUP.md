# Plivo Real-Time Phone Calling — Setup Guide

This guide covers end-to-end setup for PSTN calling through Plivo in DharwinOne, including in-app audio via the Plivo Client SDK.

## Architecture

```
Mobile App (Plivo Browser SDK + WebRTC)
    ↓ SIP login / outbound call
Plivo Cloud
    ↓ PSTN
External phone number

Mobile App ← REST API → dharwinone_calling_backend ← webhooks ← Plivo
```

**Client mode (default):** The app registers a per-user SIP endpoint, connects through WebRTC, and places the outbound call. Audio flows through the device microphone/speaker.

**Server mode (fallback):** The backend initiates a REST outbound call directly to the callee (monitor-only, no in-app audio). Use `{ "mode": "server" }` in `POST /v1/calls`.

## Prerequisites

1. [Plivo account](https://console.plivo.com/) with Voice enabled
2. Plivo phone number (E.164) for outbound caller ID
3. Public HTTPS URL for webhooks (ngrok in development)
4. Mobile **development build** (Expo Go is not supported — WebRTC requires native modules)

## Backend setup

### Environment variables

Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|----------|----------|-------------|
| `PLIVO_AUTH_ID` | Yes | Plivo Auth ID |
| `PLIVO_AUTH_TOKEN` | Yes | Plivo Auth Token |
| `PLIVO_PHONE_NUMBER` | Yes | Outbound caller ID (E.164) |
| `PLIVO_WEBHOOK_BASE_URL` | Yes* | Public HTTPS base URL (no path suffix) |
| `PLIVO_VERIFY_WEBHOOKS` | No | Verify `X-Plivo-Signature-V3` on webhooks (default: true in production) |
| `TRUST_PROXY_HOPS` | Yes behind proxy | Set to `1` when using ngrok or a load balancer |
| `PLIVO_APP_ID` | No | Existing Plivo application ID (auto-created if unset) |
| `JWT_SECRET` | Yes | Must match main backend |
| `MONGODB_URL` | Yes | Calling service database |

### Run the service

```bash
cd dharwinone_calling_backend
npm install
npm run migrate:indexes
npm run dev
```

### Development with ngrok

```bash
ngrok http 3001
# Set PLIVO_WEBHOOK_BASE_URL=https://<id>.ngrok-free.app
# Set TRUST_PROXY_HOPS=1
```

## Mobile app setup

### Environment

In `dharwinone_app/.env`:

```
EXPO_PUBLIC_CALLING_API_URL=http://<your-lan-ip>:3001/v1
```

### Development build

```bash
cd dharwinone_app
npm install
npx expo prebuild
npx expo run:ios   # or run:android
```

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/calls` | Initiate call (`mode: client` default) |
| `POST` | `/v1/calls/register` | Link Plivo call UUID to DB record |
| `POST` | `/v1/calls/:callSid/end` | End call |
| `GET` | `/v1/calls/:id/status?sync=true` | Get status (optional Plivo sync) |
| `GET` | `/v1/calls/:id` | Call details |
| `GET` | `/v1/calls` | Call history |
| `GET` | `/v1/recordings` | List recordings |
| `GET` | `/v1/telephony/credentials` | SIP endpoint credentials |

### Initiate client call

```bash
curl -X POST http://localhost:3001/v1/calls \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"to": "+14155551234", "mode": "client"}'
```

Response includes `credentials` (username/password) for Plivo SDK login.

## Call flow (client mode)

1. User dials from Contacts → Dial Pad / Contact Book / History
2. `POST /v1/calls` creates a pending call record + returns SIP credentials
3. App logs into Plivo SDK and calls the destination number (`client.call(PSTN)`)
4. Plivo fetches `POST /v1/xml/answer` → `<Dial><Number>` bridges SDK leg to PSTN with recording
5. App shows **Ringing** immediately from SDK events (`onCallRemoteRinging` / `onCallConnected`); **Connected** on `onCallAnswered` / `onMediaConnected`
6. Webhooks (`plivo-dial-status`, `plivo-call-status`) reconcile status, duration, and terminal cause
7. App registers Plivo `callUUID` via `POST /v1/calls/register`
8. Call ends → hangup webhooks set terminal status → recording webhook → available in history/details

## Webhooks

| Endpoint | Event |
|----------|-------|
| `POST /v1/webhooks/plivo-call-ring` | Ringing |
| `POST /v1/webhooks/plivo-call-status` | Answer, hangup, failed |
| `POST /v1/webhooks/plivo-dial-status` | B-leg dial progress (ringing → answered) |
| `POST /v1/webhooks/plivo-recording` | Recording ready |
| `POST /v1/xml/answer` | Answer XML (SDK outbound Dial or server hold) |

All webhook routes validate Plivo V3 signatures when `PLIVO_VERIFY_WEBHOOKS` is enabled (default in production).

## Testing checklist

### Manual

- [ ] Outbound call to a real phone number (client mode)
- [ ] Hear audio on both sides (app ↔ phone)
- [ ] Mute / speaker controls during call
- [ ] End call from app
- [ ] Verify call history shows correct status and duration
- [ ] Verify recording appears in call details
- [ ] Test failed call (invalid number)
- [ ] Test no-answer / busy scenarios

### Backend

```bash
cd dharwinone_calling_backend
npm test
```

### Webhook testing

Use ngrok request inspector or Plivo console logs to verify webhook delivery and signature validation.

## Known limitations

- **Plivo Browser SDK on mobile** uses WebRTC via `@livekit/react-native-webrtc` globals. For production-grade mobile UX (CallKit, PushKit, background incoming), consider Plivo native iOS/Android SDKs with a custom native bridge.
- **Inbound PSTN to app** requires additional Plivo DID routing and push notification setup (not yet implemented).
- **Server mode** does not provide in-app audio — use only as fallback.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Call connects but no audio | Ensure dev build (not Expo Go); grant microphone permission |
| Webhooks not received | Verify `PLIVO_WEBHOOK_BASE_URL` is public HTTPS |
| `502` on initiate | Check Plivo credentials and phone number format |
| Login failed (SDK) | Confirm SIP endpoint was created (`GET /v1/telephony/credentials`) |
| Status stuck on "Calling…" | SDK events should update Ringing/Connected locally; confirm backend logs show `[Plivo] Answer URL POST` when placing a call; check ngrok; try `GET /calls/:id/status?sync=true` |
