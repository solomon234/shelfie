# Shelfie

A self-hosted pantry tracker built as a PWA. Scan items in, track expiry per
package, and get alerted before food goes off.

> **Status: early scaffold.** The server, schema, Docker image and CI work;
> none of the features below are built yet.

## Planned

- **Per-lot expiry.** Two packs of the same product keep separate dates.
- **Expiry alerts.** A daily check posts to [ntfy](https://ntfy.sh) or a generic webhook.
- **Offline capture.** Scan at the store with no signal; changes queue on the
  device and sync when you're back online.
- **Barcode scanning** in the browser, with product lookup via
  [Open Food Facts](https://world.openfoodfacts.org).
- **Shopping list** and **multiple users and households.**

## Stack

Hono on Node 24, SQLite (`node:sqlite`, no native build step), Preact and Vite.
One container, one database file.

## Run it

```sh
docker run -d -p 8787:8787 -v shelfie-data:/data ghcr.io/solomon234/shelfie:latest
```

The camera needs HTTPS on phones. Tailscale (`tailscale serve`) or a reverse
proxy both work.

## Develop

```sh
npm install
npm run dev:server   # API on :8787
npm run dev:web      # Vite on :5173, proxies /api
npm test
```

Requires Node 24 or newer.

## License

MIT
