-- Connected agents over OAuth (e.g. a ChatGPT connector), beside API keys.
-- An app registers itself (oauth_clients); when the user approves it on the
-- consent page, that makes an agent_keys row with the app's client_id (its
-- key_hash is of a secret nobody holds), and the app's access and refresh
-- tokens act as that key. Deleting the key, or anything that deletes every
-- key, ends the connection.
CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,     -- self-reported
  redirect_uris TEXT NOT NULL,     -- JSON array
  secret_hash   TEXT,              -- null for public clients
  created_at    INTEGER NOT NULL
);

ALTER TABLE agent_keys ADD COLUMN client_id TEXT REFERENCES oauth_clients(id) ON DELETE CASCADE;

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  key_id         TEXT NOT NULL REFERENCES agent_keys(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  key_id     TEXT NOT NULL REFERENCES agent_keys(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,        -- access | refresh
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_tokens_key ON oauth_tokens(key_id);
