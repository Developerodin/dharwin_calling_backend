# DharwinOne Calling Backend

Dedicated microservice for **Plivo Voice Calling** and **Contact Management**.

## Quick start

```bash
cp .env.example .env
# Set MONGODB_URL, JWT_SECRET (same as main backend), PLIVO_* credentials
npm install
npm run dev
```

Default port: **3001** (`/v1/...` API prefix).

## API routes

| Module | Base path |
|--------|-----------|
| Contacts | `/v1/contacts` |
| Calls | `/v1/calls` |
| Recordings | `/v1/recordings` |
| Reports | `/v1/reports` |
| Webhooks | `/v1/webhooks/plivo-*` |
| Answer XML | `/v1/xml/answer` |

## Auth

Uses the **same `JWT_SECRET`** as `dharwinone_backend`. Mobile/web clients pass the existing Bearer access token.

## Frontend

Set in `dharwinone_app`:

```env
EXPO_PUBLIC_CALLING_API_URL=http://localhost:3001/v1
```

## Docs

See [docs/PLIVO.md](docs/PLIVO.md) for Plivo setup, webhooks, and sample requests.

## Tests

```bash
npm test
```

## Database

Uses a **separate MongoDB database** (recommended: `dharwinone_calling`). Run index migration:

```bash
npm run migrate:indexes
```
