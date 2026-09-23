-- account_id is the owning user's id while the app is single-user.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  hostname        TEXT NOT NULL,
  os              TEXT NOT NULL,
  arch            TEXT NOT NULL,
  version         TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER,
  revoked_at      INTEGER
);
CREATE INDEX devices_account ON devices(account_id);

CREATE TABLE enroll_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  device_id  TEXT
);
