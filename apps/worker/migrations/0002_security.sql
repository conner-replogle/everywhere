-- TOTP two-factor auth. Secrets are AES-GCM encrypted with the TOTP_KEY secret.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending TEXT;
-- Last accepted TOTP time step, so a code can't be replayed.
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

CREATE TABLE recovery_codes (
  code_hash TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_at   INTEGER
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

-- Password verified, waiting for the second factor.
CREATE TABLE mfa_challenges (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE sessions ADD COLUMN created_at INTEGER;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
CREATE INDEX sessions_user ON sessions(user_id);
