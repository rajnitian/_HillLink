# HillLink (demo build)
Run: `npm install && npm start` → http://localhost:3000 · Tests: `npm test`

Roles use demo API keys (`demo-hospital`, `demo-dispatcher`, `demo-admin`); override with `KEY_HOSPITAL`, `KEY_DISPATCHER`, `KEY_ADMIN`. Other env: `PORT`, `OUTREACH_BATCH` (2), `RESPONSE_TIMEOUT_MIN` (10), `SMS_PROVIDER` (mock).
Data persists to `data/db.json` (synthetic only).

## Flow
Hospital creates request (demo/unverified) → verifies → Matching → "Send SMS batch" (mock outbox) → Admin tab simulates reply 1/2 (`POST /webhooks/sms {from, body}`) → dispatcher assigns ambulance (recorded only) → complete.

## Limitations
Mock SMS only; real provider, webhook signature check, OSM road import, live weather/traffic, and ambulance dispatch are NOT implemented. Road graph is synthetic. Plain JS/JSON-file storage, not React/TS/SQL. Offline: only drafts and retry queue work; map tiles, weather and sync need internet; SMS itself needs no internet. Auth keys are demo-grade.
