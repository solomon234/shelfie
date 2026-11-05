---
id: SPEC-shelfie
companions:
  - stack.md
  - data-model.md
  - offline-sync.md
  - architecture-diagrams.md
  - ux-flows.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Shelfie

## Why

A vision to realize, driven by a pain: the owner's household throws away food because nothing nudges them before it expires, and capturing groceries at the store fails without signal. Surveyed self-hosted pantry apps (GhostPantry, Pantry Host, Grocy, EverShelf, Pantrie) were not confirmed to combine per-package expiry, proactive alerts and offline capture with sync. Shelfie is a public, MIT, self-hosted PWA that does all three on a home server (a Jetson) with minimal operations.

## Capabilities

- **CAP-1**
  - **intent:** An operator can claim a fresh instance only with a secret, then create users and households and let members sign in.
  - **success:** A fresh instance rejects setup without `SHELFIE_SETUP_TOKEN`; with it, setup creates the first admin once and never again; members only ever see their own households' data.
- **CAP-2**
  - **intent:** A member can record each purchased package as its own lot with location, quantity, unit and optional expiry, then consume, move or adjust it.
  - **success:** Two packs of one product with different expiry dates show as two lots; consuming the last unit removes the lot.
- **CAP-3**
  - **intent:** A member can scan a barcode with the phone camera and get the product's name, brand and image filled in, or enter it manually.
  - **success:** Scanning a UPC-A and the same product's EAN-13 resolves to one product; an unknown barcode falls back to manual entry without blocking.
- **CAP-4**
  - **intent:** A household sees what is expired or about to expire and is told before food goes off.
  - **success:** The dashboard lists expired lots and lots inside the household's warning window; a household can set its own timezone and the time of day it receives alerts; a lot entering the window produces exactly one ntfy or webhook message at the next alert time in that household's timezone.
- **CAP-5**
  - **intent:** A household shares one shopping list, can add items manually or from inventory, and tick them off.
  - **success:** An item added on one device appears on another household member's device; ticking persists.
- **CAP-6**
  - **intent:** A member with no connectivity can open the app, see last-known stock, scan, add and consume, and have those changes reach the server exactly once when connectivity returns.
  - **success:** In airplane mode, three scanned adds and one consume succeed locally; after reconnecting, a second device shows each exactly once, even if replay is interrupted and retried; offline scans without a resolved name show as pending until the server names them.
- **CAP-7**
  - **intent:** A member can install Shelfie to their phone home screen and launch it offline.
  - **success:** Android shows the install prompt and iOS Add to Home Screen opens a standalone app; the app shell loads with the network off.
- **CAP-8**
  - **intent:** An operator can run Shelfie as one container with one database file, upgrade it without losing data, and back it up consistently.
  - **success:** `docker run` of the published image on amd64 and arm64 serves `/api/health`; opening a database from an older schema version migrates it without data loss; a backup taken while running restores to a database passing `PRAGMA integrity_check`.

## Constraints

- One container and one SQLite file; no external service is required (ntfy and Open Food Facts are optional or best-effort). Stack and deploy specifics in `stack.md`.
- Every queueable write carries a client-generated id; the server is idempotent per `(household_id, client_id)`. Replay triggers on the `online` event and on app open because iOS has no Background Sync (`offline-sync.md`).
- Offline consume is queued as a delta, not an absolute quantity. On replay the delta is applied floored at zero and the user is told ("already used elsewhere"); a conflict is never rejected or left in the needs-attention list.
- Every row is scoped to a household and composite foreign keys forbid cross-household references (`data-model.md`).
- Schema changes ship only as ordered migrations tracked by `PRAGMA user_version`, never destructive to existing volumes.
- Dates are ISO `YYYY-MM-DD` enforced by `CHECK`; timestamps are one ISO-8601 UTC format so string comparison stays valid.
- Barcodes are normalized to EAN-13 form before lookup and as the unique key. A lot with no barcode matches or creates a product by case-insensitive name.
- Roles: members add, consume, move and edit lots and use the shopping list; owners additionally manage users, the warning window and alert targets; instance admins create households. Permission checks live in one place.
- An alert fires once per lot per state transition (enters the warning window, becomes expired), recorded in `alert_state` so it is not repeated.
- Unknown `/api/*` returns JSON 404, never the SPA shell; the unauthenticated surface is limited to health, setup and login.
- The camera needs HTTPS; the deployment provides it (Tailscale serve or reverse proxy).
- SQLite runs in WAL mode and its volume must be local disk, never NFS or SMB; backups use SQLite's online backup, not a file copy.
- The repository is public: no secrets or host-specific values are committed; deployment values live in the private `pantry-deploy` repo and environment variables.

## Non-goals

- Native push notifications (v1 alerts go through ntfy or a generic webhook).
- Receipt import.
- Home Assistant integration (a generic webhook can serve it later).
- Native mobile apps.
- Recipes and meal planning.
- Price tracking.
- Hosted multi-tenant SaaS.
- Repeat or daily reminder alerts (an alert fires once per lot per state transition).
- Data export in JSON or CSV (a SQLite backup is the v1 portability story).

## Success signal

On a phone with the app installed and airplane mode on, the owner scans three items with expiry dates and consumes one; after reconnecting they appear exactly once on a second device; an item expiring tomorrow produces one ntfy message the next morning; and a freshly deployed instance cannot be claimed without the setup token.

## Assumptions

- Open Food Facts is the only product source, called server-side with a descriptive User-Agent; offline scans queue the raw barcode.
- Each household sets its own timezone and alert time of day (user-confirmed); it drives expiry day boundaries and when alerts send. Defaults, if unset, are the server's `TZ` and 08:00 (assumed).
- Companion details are proposed design, not user-confirmed: the `POST /api/sync` batch endpoint, `alert_state` table, per-household `timezone` and `alert_hour` columns, UUID v4 client ids, hashed session tokens, rate limits and body-size limits.
- The existing scaffold on `main` predates this spec: its schema needs a migration to composite foreign keys, `CHECK`s and scoped `client_id`.
