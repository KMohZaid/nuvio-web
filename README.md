# Nuvio Web PWA

Mobile-first browser proof of concept for Nuvio accounts and Stremio addons.

## Run

```powershell
npm install
npm run dev
```

The official backend is read from `NUVIO_SUPABASE_URL` and
`NUVIO_SUPABASE_ANON_KEY` in `.env.local`. You can also select **Self-hosted**
on the sign-in screen and enter a URL and publishable key on the device.

## Current scope

- Persistent sign-in and session refresh
- Synced profiles, installed addons, library, and read-only watch progress
- Direct addon manifest/catalog/meta/stream calls
- Responsive home, discover, library, addons, and settings views
- Series episodes and source selection
- Native video/HLS.js playback with external handoff
- Installable PWA shell and cached application assets

Playback progress writes are intentionally disabled in this first test build.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and limitations.

