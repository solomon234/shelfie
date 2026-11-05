# Data model

Target schema after migration 1. All ids are integer primary keys unless noted. All timestamps are ISO-8601 UTC text (`YYYY-MM-DDTHH:MM:SSZ`); all dates are `YYYY-MM-DD`.

| Table | Columns | Constraints |
|---|---|---|
| `users` | `id`, `username`, `password_hash`, `is_admin`, `created_at` | `username` unique, case-insensitive. |
| `sessions` | `token_hash` (PK), `user_id`, `expires_at` | Cascade on user delete; expired rows purged on login. |
| `households` | `id`, `name`, `timezone`, `expiry_warning_days`, `alert_hour` | `name` not unique; `expiry_warning_days >= 0`; `timezone` an IANA name. |
| `memberships` | `user_id`, `household_id`, `role` | PK `(user_id, household_id)`; `role IN ('owner','member')`. |
| `locations` | `id`, `household_id`, `name`, `kind` | `UNIQUE(id, household_id)`; `kind IN ('pantry','fridge','freezer','other')`. |
| `products` | `id`, `barcode`, `name`, `name_key`, `brand`, `image_url`, `resolved` | `barcode` unique when not null, stored as EAN-13; `name_key` is the lower-cased trimmed name, unique where `barcode IS NULL`, so a lot with no barcode matches or creates a product by name; `resolved` 0 until the server names an offline scan. |
| `lots` | `id`, `client_id`, `household_id`, `location_id`, `product_id`, `quantity`, `unit`, `expires_on`, `purchased_on`, `notes`, `created_by`, `created_at` | `UNIQUE(household_id, client_id)`; `FOREIGN KEY(location_id, household_id)` references `locations(id, household_id)`; `quantity > 0`; `expires_on` and `purchased_on` `CHECK(x IS NULL OR date(x) = x)`; index on `(household_id, expires_on)`. |
| `shopping_items` | `id`, `client_id`, `household_id`, `name`, `quantity`, `unit`, `checked` | `UNIQUE(household_id, client_id)`. |
| `settings` | `key`, `value` | Key/value store; holds the VAPID key pair (`vapid_public`, `vapid_private`), generated once so devices stay subscribed across restarts. |
| `push_subscriptions` | `id`, `user_id`, `endpoint`, `p256dh`, `auth`, `user_agent`, `created_at` | `endpoint` unique; cascade on user delete; `endpoint` must be https on a known push service host (FCM, Mozilla, Apple, Windows) so the server cannot be pointed at internal addresses; rows are deleted when the push service reports them gone (404/410). |
| `alert_state` | `lot_id`, `state`, `notified_at` | PK `(lot_id, state)`, `state IN ('warning','expired')`; written after a successful send so each transition notifies once. |

## Rules

- Consuming a lot's last unit deletes the lot (`quantity > 0` forbids zero); the delete is not an error on replay if the lot is already gone.
- Barcode normalization: strip non-digits; 12-digit UPC-A becomes EAN-13 by prefixing `0`; 8-digit EAN-8 and others kept as-is; reject lengths other than 8, 12, 13.
- Migrations are numbered scripts applied in order inside a transaction, recording the version in `PRAGMA user_version`; the server refuses to start if the database version is newer than the code.
- A household's alert day boundary uses its `timezone`; `alert_hour` is the local hour for the daily check.
