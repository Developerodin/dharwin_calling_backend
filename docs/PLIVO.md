# Plivo Voice Calling

This service uses [Plivo Voice API](https://www.plivo.com/docs/voice/) for PSTN outbound calling, call recording, status tracking, and reports.

## Prerequisites

1. [Plivo account](https://console.plivo.com/)
2. A Plivo phone number with Voice capability
3. A publicly reachable HTTPS URL for webhooks (use ngrok in development)

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PLIVO_AUTH_ID` | Yes | Plivo Auth ID (from console dashboard) |
| `PLIVO_AUTH_TOKEN` | Yes | Plivo Auth Token |
| `PLIVO_PHONE_NUMBER` | Yes | Outbound caller ID in E.164 format (e.g. `+14155551234`) |
| `PLIVO_WEBHOOK_BASE_URL` | Yes* | Public base URL for webhooks and answer XML |
| `BACKEND_PUBLIC_URL` | Fallback | Used when `PLIVO_WEBHOOK_BASE_URL` is unset |

\* Required for outbound calls. Example: `https://your-domain.com` (no trailing slash).

## Webhook configuration

Plivo webhooks are registered automatically when initiating outbound calls. Configure your server URL in `PLIVO_WEBHOOK_BASE_URL`.

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/xml/answer` | Returns Plivo XML when callee answers (record + hold) |
| `POST /v1/webhooks/plivo-call-ring` | Ringing status updates |
| `POST /v1/webhooks/plivo-call-status` | Hangup and call status updates |
| `POST /v1/webhooks/plivo-recording` | Recording ready callback |

### Signature validation

In production, all Plivo webhooks are validated using `X-Plivo-Signature-V3` and `X-Plivo-Signature-V3-Nonce` headers. Ensure `PLIVO_AUTH_TOKEN` is set.

Behind a reverse proxy, set `TRUST_PROXY_HOPS` so the webhook URL is reconstructed correctly.

## API endpoints

All endpoints require JWT Bearer auth (same `JWT_SECRET` as main backend) except public XML/webhook routes.

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/v1/calls` | `calls.manage` | Initiate outbound call (`mode`: `client` or `server`) |
| `POST` | `/v1/calls/:callSid/end` | `calls.manage` | Hang up call |
| `GET` | `/v1/calls` | `calls.read` | List call history |
| `GET` | `/v1/calls/:id/status` | Get call status (`?sync=true` polls Plivo) |
| `GET` | `/v1/calls/:id` | Get call details (Mongo ID or call UUID) |
| `GET` | `/v1/telephony/credentials` | SIP credentials for mobile SDK |
| `POST` | `/v1/calls/register` | Register client SDK call UUID |
| `GET` | `/v1/recordings` | `calls.read` | List recordings |
| `GET` | `/v1/recordings/:id` | `calls.read` | Get recording |
| `GET` | `/v1/reports` | `calls.read` | List call reports |
| `GET` | `/v1/reports/export` | `calls.read` | Export reports as CSV |

### Initiate call

```bash
curl -X POST http://localhost:3001/v1/calls \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"to": "+14155551234"}'
```

Or call a saved contact:

```json
{ "contactId": "507f1f77bcf86cd799439011" }
```

### Response fields

- `callSid` — Plivo `call_uuid` (kept as `callSid` for API compatibility)
- `recordingSid` — Plivo `RecordingID`
- `providerResponse` — Raw Plivo API/webhook payload (also exposed as `twilioResponse` for legacy clients)

## Call flow

```
Client → POST /v1/calls
       → Plivo REST API creates outbound call
       → Callee answers → Plivo fetches /v1/xml/answer (Record + Wait)
       → Ring/status/recording webhooks update MongoDB
       → Terminal status generates CallReport
```

## Database

Historical Twilio call data is preserved in existing MongoDB collections (`twiliocalls`, `twiliocallrecordings`, `twiliocallreports`). New Plivo calls use the same collections; `callSid` stores Plivo call UUIDs.

## Development with ngrok

```bash
ngrok http 3001
# Set PLIVO_WEBHOOK_BASE_URL=https://<ngrok-id>.ngrok.io
npm run dev
```

## Migration from Twilio

1. Remove `TWILIO_*` environment variables
2. Add `PLIVO_*` credentials
3. Update mobile app API paths from `/twilio/*` to `/calls/*`
4. Configure Plivo number application or rely on per-call webhook URLs (this service uses per-call URLs)
