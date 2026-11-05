# Shelfie

A self-hosted pantry tracker built as a PWA. Scan items in, track expiry per package, get alerted before
food goes off, and keep working at the store with no signal.

## Features

- **Per-lot expiry.** Two packs of the same product keep separate dates. The home screen lists what is expired or
  about to expire.
- **Expiry alerts.** A daily check, at a time and timezone you choose per household, posts to
  [ntfy](https://ntfy.sh) and/or a generic webhook. Each item alerts once when it enters the warning window and once
  when it expires.
- **Offline capture.** The app opens with no connection, shows your last-known stock, and lets you scan, add, use up
  and move items. Changes queue on the device and sync, exactly once each, when you are back online.
- **Barcode scanning** in the browser (UPC-A, EAN-13, EAN-8) with product lookup through
  [Open Food Facts](https://world.openfoodfacts.org). Offline scans are named by the server after syncing.
- **Shopping list**, **households** with owners and members, and an installable PWA for Android and iOS.

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
