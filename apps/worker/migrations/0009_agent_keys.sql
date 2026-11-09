-- An early draft of 0008 made OAuth tables and a different agent_activity
-- before connected agents settled on API keys; some databases ran it. This
-- brings either version to the final shape. Nothing has been logged yet.
DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_codes;
DROP TABLE IF EXISTS oauth_grants;
DROP TABLE IF EXISTS oauth_clients;

CREATE TABLE IF NOT EXISTS agent_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE, -- sha256 of the secret
  hint         TEXT NOT NULL,        -- its last 4 characters
  scopes       TEXT NOT NULL,        -- space-separated: read drive projects
  devices      TEXT NOT NULL,        -- JSON array of device ids
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_keys_user ON agent_keys(user_id);

DROP TABLE IF EXISTS agent_activity;
CREATE TABLE agent_activity (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id    TEXT NOT NULL,
  key_name  TEXT NOT NULL,
  tool      TEXT NOT NULL,
  device_id TEXT,
  thread_id TEXT,
  ok        INTEGER NOT NULL,
  error     TEXT,
  at        INTEGER NOT NULL
);
CREATE INDEX agent_activity_user_at ON agent_activity(user_id, at, id);
