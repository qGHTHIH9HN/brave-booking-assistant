# Brave Booking Assistant — dashboard starter

This is a deployable static starter dashboard for Vercel. It is not yet connected to the Brave extension or a shared database. Settings are stored in the current browser's localStorage only. No booking actions are implemented.

## Deploy
Upload `index.html`, `package.json`, and `README.md` to the root of the `brave-booking-assistant` GitHub repository. Commit to `main`. In Vercel, use Framework Preset **Other**, Root Directory `./`, and default settings. If Vercel asks for an output directory, use `.`. 

## Future architecture
Use authenticated APIs and managed persistent database, with least-privilege extension permissions, audit logging, and approval before any real booking submission. Never store guest details in a public repository.
