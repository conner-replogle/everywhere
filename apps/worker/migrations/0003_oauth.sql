-- OAuth 2.1 for the MCP endpoint (/mcp), so agents like ChatGPT connectors
-- can act on the account. Clients register themselves (RFC 7591); the user
-- approves each one on a consent page, creating a grant.
CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,   -- JSON array
  secret_hash   TEXT,            -- NULL for public clients (PKCE only)
  created_at    INTEGER NOT NULL
);

-- One approval of a client by a user. Its codes and tokens die with it.
CREATE TABLE oauth_grants (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX oauth_grants_user ON oauth_grants(user_id);

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  grant_id       TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,  -- S256
  expires_at     INTEGER NOT NULL
);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id   TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,      -- access | refresh
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
