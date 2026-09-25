-- Web Push subscriptions: one per browser that turned notifications on. They
-- die with the session that made them, so a signed-out browser stops getting
-- thread names.
CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,  -- the browser's public key (base64url)
  auth       TEXT NOT NULL,  -- its auth secret (base64url)
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX push_subscriptions_session ON push_subscriptions(session_id);
