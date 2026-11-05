# Stack and deployment

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node 24 | Native TypeScript type stripping; `engines >=24`. |
| Server | Hono + `@hono/node-server` | Serves `/api/*` and the built SPA from one process. |
| Database | SQLite via `node:sqlite` | WAL, `foreign_keys=ON`; one connection; file at `SHELFIE_DB` (default `/data/shelfie.db` in the image). |
| Frontend | Preact + Vite | Barcode scanning in-browser; IndexedDB outbox; service worker for the app shell and read-only `GET` cache. |
| Image | `node:24-slim`, multi-stage | Runs as `node`; `/data` volume; `HEALTHCHECK` on `/api/health`. |
| CI | GitHub Actions | typecheck, tests, build; image smoke test (run the image, hit `/api/health` and `/`); push multi-arch (amd64, arm64) to `ghcr.io/solomon234/shelfie`; workflow `permissions: contents: read`, actions pinned by SHA. |
| Deploy | Private Gitea `pantry-deploy` | Compose pulls a pinned GHCR tag; workflow syncs compose to the Jetson and runs `docker compose pull && up -d`. Secrets in `.env` on the host. |

## Configuration (environment)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port; must be an integer, else startup fails clearly. |
| `SHELFIE_DB` | SQLite path; startup prints a clear message if the directory is not writable. |
| `SHELFIE_SETUP_TOKEN` | Required to complete first-run setup. |
| `SHELFIE_NTFY_URL` | Optional ntfy topic URL for alerts. |
| `SHELFIE_WEBHOOK_URL` | Optional generic webhook for alerts. |
| `SHELFIE_VAPID_SUBJECT` | `mailto:` or `https:` contact sent to push services in the VAPID claim (default `mailto:admin@shelfie.local`). |
| `OFF_USER_AGENT` | Descriptive User-Agent for Open Food Facts requests. |
| `TZ` | Process timezone; per-household timezone overrides for alerts. |

## Conventions

- Server code is erasable TypeScript only (no enums or parameter properties) with `.ts` import suffixes.
- Server and web have separate tsconfigs; the server config excludes `DOM`.
- App wiring (routes, static serving, SPA fallback) lives in `createApp` so tests exercise it; `index.ts` only reads env and listens.
- Tests use `node --test` with a glob; DB tests open `:memory:`.
- Sessions: random token, stored hashed, cookie `HttpOnly; SameSite=Lax`, `Secure` when served over HTTPS.
- Request bodies are size-limited; login and setup are rate-limited.
- Startup fails with a clear message when the built frontend is missing, the data directory is not writable, or `PORT` is invalid.
- Release tags are `v*.*.*` (valid semver); the GHCR package is public so the Jetson pulls without credentials.
- Tests cover schema constraints and foreign-key enforcement (`:memory:` databases), the SPA fallback and API 404, idempotent replay, and migrations from each prior version.

## Brownfield note

`main` holds a scaffold: health endpoint, an initial schema, placeholder Preact page, Dockerfile, CI. Its schema predates `data-model.md` and is replaced by migration 1 (the project has no production data).
