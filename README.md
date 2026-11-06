# Shelfie

A self-hosted pantry tracker built as a PWA. Scan items in, track expiry per package, get alerted before
food goes off, and keep working at the store with no signal.

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/solomonmurf)

## Features

- **Per-lot expiry.** Two packs of the same product keep separate dates. The home screen lists what is expired or
  about to expire.
- **Food, medicine, gear and household supplies.** Each item has a category, so emergency and safety supplies
  (water filters, batteries, first-aid kits, extinguishers) are tracked with the same dates and alerts as food.
  Dates read "Best before", "Expires" or "Replace by" to match, and gear is retired rather than used up.
- **Expiry alerts.** A daily check, at a time and timezone you choose per household, sends a push notification to
  every device that turned on notifications in Settings (Web Push from the installed app, no extra app needed), and
  optionally to [ntfy](https://ntfy.sh) or a generic webhook. Each item alerts once when it enters the warning window and once
  when it expires.
- **Offline capture.** The app opens with no connection, shows your last-known stock, and lets you scan, add, use up
  and move items. Changes queue on the device and sync, exactly once each, when you are back online.
- **Barcode scanning** in the browser (UPC-A, EAN-13, EAN-8) with product lookup through
  [Open Food Facts](https://world.openfoodfacts.org). Offline scans are named by the server after syncing.
- **Shopping list**, **households** with owners and members (members can change their own password), and an installable PWA for Android and iOS.

## Run it

```sh
docker run -d --name shelfie -p 8787:8787 \
  -e SHELFIE_SETUP_TOKEN="$(openssl rand -hex 16)" \
  -v shelfie-data:/data \
  ghcr.io/solomon234/shelfie:latest
```

Open the app, choose **First time? Set up this instance**, and enter the setup token plus your admin account. Setup
works once; without `SHELFIE_SETUP_TOKEN` it is disabled. The image is multi-arch (amd64 and arm64).

**HTTPS is required on phones** for the camera and for installing the app. Put Shelfie behind
[Tailscale](https://tailscale.com) (`tailscale serve`) or a reverse proxy with a real certificate.

### Configuration

| Variable | Purpose |
|---|---|
| `SHELFIE_SETUP_TOKEN` | Required to complete first-run setup. |
| `SHELFIE_DB` | SQLite path (default `/data/shelfie.db` in the image). Keep it on a local disk, never NFS or SMB. |
| `PORT` | HTTP port (default `8787`). |
| `SHELFIE_NTFY_URL`, `SHELFIE_WEBHOOK_URL` | Default alert targets; a household can set its own in Settings. |
| `OFF_USER_AGENT` | User-Agent sent to Open Food Facts. |

### Backups

```sh
docker exec shelfie node src/server/backup.ts /data/backups
```

Uses SQLite's online backup, so it is safe while the app is running. Each backup is verified and the newest 14 are
kept (`SHELFIE_BACKUP_KEEP` to change). Restore by stopping the container and copying a backup over
`shelfie.db`.

### On Cloudflare Workers

Shelfie also runs on Cloudflare's free plan, with HTTPS included and no server to look after. One SQLite-backed
Durable Object holds the database, the frontend is served as static assets, and a Durable Object alarm sends the
expiry alerts.

```sh
npm install
npx wrangler secret put SHELFIE_SETUP_TOKEN   # after the first deploy
npm run deploy:worker                         # builds the frontend, then wrangler deploy
```

Set the name and the `routes` entry in `wrangler.jsonc` to your own domain (or delete `routes` to use the
`workers.dev` address). Setup, households and members work as above. Optional variables (`SHELFIE_VAPID_SUBJECT`,
`SHELFIE_NTFY_URL`, `SHELFIE_WEBHOOK_URL`) go in `vars` in `wrangler.jsonc`.

Worker requests have a small CPU budget, so the Worker runs in **client password mode**: the browser stretches the
password with PBKDF2 (600,000 iterations) and the server stores only a salted hash of that. The Docker image keeps
hashing on the server with scrypt. Anyone calling the API directly in client mode has to send that stretched value
as `password`; see `web/src/kdf.ts`. Backups are Cloudflare's 30-day point-in-time recovery for Durable Objects, not
the script above.

## Develop

```sh
npm install
npm run dev:server   # API on :8787 (API only)
npm run dev:web      # Vite on :5173, proxies /api
npm test
```

Requires Node 24 or newer. The stack is Hono, `node:sqlite`, Preact and Vite; the design lives in
[`docs/specs/spec-shelfie`](docs/specs/spec-shelfie/SPEC.md).

## License

MIT
