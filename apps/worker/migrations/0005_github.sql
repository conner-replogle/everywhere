-- A GitHub account connected through our OAuth app, one per user. The token
-- is sealed (secretbox.ts) and only ever leaves the Worker to a daemon, for
-- the one clone it's needed for.
CREATE TABLE github_accounts (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  login        TEXT NOT NULL,
  token_sealed TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
