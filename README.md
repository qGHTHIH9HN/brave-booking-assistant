# Brave Booking Assistant — Cloud Dashboard v2

## Deploy
Upload the contents of this folder to the **root** of the existing `brave-booking-assistant` GitHub repository (keep `api/settings.js` in the `api` folder). Vercel will redeploy from `main`.

## Environment variables
`DATABASE_URL` is supplied by Neon integration. Add `DASHBOARD_ADMIN_KEY` to Vercel Project → Settings → Environment Variables (Production). Generate a long random secret, keep it private, and redeploy. **Never commit secrets or actual guest information to GitHub.**

## How to use
Open deployed dashboard, paste the administrator key into the access field, click Load saved settings, edit the property, and Save to cloud. The first API call creates a small table in Neon.

## Scope
This release stores only property name, Booking.com listing URL, and nonpersonal testing notes. It does not yet connect Brave extensions, fill forms, or submit bookings. The admin key is intentionally not stored in browser localStorage. The API uses server-side SQL queries with parameterized writes.

## Important
Do not embed `DASHBOARD_ADMIN_KEY` in the extension: the next stage requires separate short-lived or limited-scope client authorization. Review Neon TLS configuration for production. Public GitHub repositories must contain no database credentials.
