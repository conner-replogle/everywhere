-- Connected agents: an MCP endpoint (/mcp) for outside AI apps, authorized by
-- API keys. Off until the user turns it on (with their password), and each
-- device must allow it too (on the device). Each key has scopes and the
-- devices it may reach, and expires.
ALTER TABLE users ADD COLUMN agents_enabled_at INTEGER;

CREATE TABLE agent_keys (
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
CREATE INDEX agent_keys_user ON agent_keys(user_id);

-- Every tool call a connected agent makes, for Settings → Connected agents.
-- Kept when its key is deleted.
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
