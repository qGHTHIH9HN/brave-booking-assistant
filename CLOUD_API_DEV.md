# Cloud management API — development branch

This branch adds authenticated serverless endpoints for managing multiple properties and internal booking drafts.

## Existing production behavior
- `GET/PUT /api/settings` remains unchanged.
- No existing property data is migrated or deleted.
- The existing Brave extension is unchanged.

## New endpoints (not yet deployed or integration-tested)
- `GET /api/properties`: list properties (up to 200)
- `GET /api/properties?id=<uuid>`: get one property
- `POST /api/properties`: create with `{ "name": "...", "url": "https://www.booking.com/...", "notes": "" }`
- `PUT /api/properties?id=<uuid>`: update
- `DELETE /api/properties?id=<uuid>`: delete (restricted if linked bookings exist)
- `GET /api/bookings`: list internal booking records (up to 200)
- `GET /api/bookings?id=<uuid>`: get one record
- `POST /api/bookings`: create with `{ "property_id": "<uuid>", "check_in": "2026-12-01", "check_out": "2026-12-03", "status": "draft", "notes": "" }`
- `PUT /api/bookings?id=<uuid>`: update
- `DELETE /api/bookings?id=<uuid>`: delete

All routes require `Authorization: Bearer <DASHBOARD_ADMIN_KEY>`. Do not expose this key in client-side code, repositories, or chat. Vercel deployment protection may additionally require authenticated access.

## Booking scope and limitations
These are **internal tracking records only**. The endpoints do not query availability, create or cancel actual Booking.com reservations, handle payments, or synchronize guest information. No guest PII is stored by these new endpoints.

Statuses: `draft`, `pending_review`, `cancelled`, `completed`. These describe the internal record, not a verified external reservation status.

## Before production deployment
1. Review and test the new endpoints against a nonproduction Neon database.
2. Add a separate scoped authentication strategy for ChatGPT integrations and browser clients; do not ship the administrator key or Vercel bypass secret in an extension.
3. Add schema migrations, per-user authorization, audit logs, rate limiting, and retention/privacy policies before handling guest PII.
4. Fix database TLS verification configuration for production (the current code uses `rejectUnauthorized:false`).
5. Confirm the existing dashboard and extension continue working.
