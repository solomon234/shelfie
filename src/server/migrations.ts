// Ordered migrations. Never edit a shipped entry; append a new one.
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

const V1 = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE households (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  expiry_warning_days INTEGER NOT NULL DEFAULT 3 CHECK (expiry_warning_days >= 0),
  alert_hour INTEGER NOT NULL DEFAULT 8 CHECK (alert_hour BETWEEN 0 AND 23),
  ntfy_url TEXT,
  webhook_url TEXT,
  last_alert_on TEXT
);
CREATE TABLE memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  PRIMARY KEY (user_id, household_id)
);
CREATE TABLE locations (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pantry' CHECK (kind IN ('pantry','fridge','freezer','other')),
  UNIQUE (id, household_id)
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  brand TEXT,
  image_url TEXT,
  resolved INTEGER NOT NULL DEFAULT 1 CHECK (resolved IN (0,1))
);
CREATE UNIQUE INDEX idx_products_name_key ON products(name_key) WHERE barcode IS NULL;
CREATE TABLE lots (
  id INTEGER PRIMARY KEY,
  client_id TEXT,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'item',
  expires_on TEXT CHECK (expires_on IS NULL OR date(expires_on) IS expires_on),
  purchased_on TEXT CHECK (purchased_on IS NULL OR date(purchased_on) IS purchased_on),
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE (household_id, client_id),
  FOREIGN KEY (location_id, household_id) REFERENCES locations(id, household_id)
);
CREATE INDEX idx_lots_expiry ON lots(household_id, expires_on);
CREATE TABLE shopping_items (
  id INTEGER PRIMARY KEY,
  client_id TEXT,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'item',
  checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0,1)),
  UNIQUE (household_id, client_id)
);
CREATE TABLE alert_state (
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('warning','expired')),
  notified_at TEXT NOT NULL DEFAULT (${NOW}),
  PRIMARY KEY (lot_id, state)
);
CREATE TABLE applied_ops (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  op TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  PRIMARY KEY (household_id, client_id)
);
`;

// Web Push: one row per subscribed device (browser), owned by a user; VAPID keys live in `settings`.
const V2 = `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
`;

export const MIGRATIONS: readonly string[] = [V1, V2];
