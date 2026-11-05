# Offline capture and sync

## Client state

- **Read cache:** the service worker caches only the app shell (so the app opens with no connection). The app itself stores each successful `GET` response (inventory, locations, shopping list, `/api/me`) in IndexedDB and falls back to it when the network is unreachable; the UI shows "last synced" when serving cached data.
- **Outbox (IndexedDB):** an ordered list of pending operations, each `{ id, client_id, type, payload, created_at, attempts }`. The UI shows a pending count.
- **Operation types:** `lot.add`, `lot.consume` (delta), `lot.move`, `shopping.add`, `shopping.toggle`, `shopping.delete`.

## Writes

1. The client generates `client_id` (UUID v4) when the user acts, applies the change optimistically to the local view, and appends to the outbox. Online or offline, writes go through the outbox so there is one code path.
2. A `lot.add` made from a scan stores the normalized barcode; if the product name is not known locally, the entry is `pending-name`.
3. The server resolves unknown barcodes at apply time (Open Food Facts); if lookup fails, it creates an unresolved product (`resolved = 0`, name = the barcode) and the UI shows "unidentified" until it is edited or resolved on a later retry.

## Replay

- Triggers: the browser `online` event, app open, and a manual "Sync now" control. No Background Sync (unavailable on iOS).
- Operations are sent in order, one request each (`POST /api/sync` accepts a batch and returns per-operation results in order).
- A single replay runs at a time (Web Locks API or a flag in IndexedDB).
- Per-operation results: `applied`, `duplicate` (same `(household_id, client_id)` already seen; treated as success), `gone` (target lot no longer exists; dropped with a notice), `invalid` (kept in a "needs attention" list, never silently dropped), `retry` (network or 5xx; stays queued with backoff).
- After a full successful pass, the client refetches inventory and clears the cached views.

## Conflict rules

The consume-conflict rule is user-confirmed; the other rows are proposed defaults.

| Case | Behavior |
|---|---|
| Add replayed twice | Second returns `duplicate`; no second lot. |
| Consume on a lot already consumed elsewhere | Delta applied floored at zero; if the lot is gone, the op returns `gone`, is dropped, and the user sees a notice. Never rejected. |
| Move to a location that was deleted | `invalid`; user picks a new location. |
| Session expired while offline | Replay pauses; user signs in; outbox retained and resumes. |

## Server contract

- `POST /api/sync` body `{ household_id, ops: [...] }`; response `{ results: [{ client_id, status, ... }] }`; each op is applied in its own transaction.
- Idempotency is enforced by `UNIQUE(household_id, client_id)` on `lots` and `shopping_items`; consume and move are idempotent through an applied-op log keyed by `(household_id, client_id)`.
