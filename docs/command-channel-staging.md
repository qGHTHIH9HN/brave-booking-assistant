# Command channel staging gate

Status: **not deployed / not connected to installed Brave**.

## Safety checks before deploying

1. Create a separate Neon branch/database and set a **branch-scoped** `DATABASE_URL` in Vercel preview. Current Vercel integration exposes the same database to production and preview.
2. Add a preview-only command token; do not reuse the dashboard-wide administrator key in a production browser extension.
3. Run `migrations/003_extension_commands.sql` on staging only.
4. Restrict the preview deployment to an allowlisted extension identity; verify access with an unauthenticated request (401), malformed payload (400), and approved command (201).
5. Validate GET claim and PATCH completion with a test command, and confirm no payment or booking submission is possible.
6. Load the extension **as an update to the existing unpacked directory**; preserve its extension ID and saved data. The v2.4 local artifact has not been pushed to this repository or installed.
7. Test popup reopening, background polling after browser restart, no-secret leakage, Booking.com listing navigation, and price inspection.
8. Only after tests, add a ChatGPT-accessible connector action for POST/GET commands and explicit confirmation for any future reservation submission.

## Current implementation limitations

- Polling is one minute and requires opt-in in the popup.
- Session credentials are cleared when Brave restarts.
- `inspect_active` captures visible text, not verified room availability.
- The queue currently has no lease/retry for commands claimed by an offline extension.
- The API uses a shared administrator key; a scoped device credential and per-device queue are required before production.
- The cloud connector available in this conversation does not expose an arbitrary HTTP POST action to this API, so chat-to-Brave control is **not connected**.
