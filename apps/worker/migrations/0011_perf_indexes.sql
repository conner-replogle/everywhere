-- Missing foreign-key cascade and expiry-cleanup indexes (verified with EXPLAIN QUERY PLAN).
CREATE INDEX IF NOT EXISTS agent_keys_client ON agent_keys(client_id);
CREATE INDEX IF NOT EXISTS oauth_codes_key ON oauth_codes(key_id);
CREATE INDEX IF NOT EXISTS oauth_codes_expires ON oauth_codes(expires_at);
CREATE INDEX IF NOT EXISTS oauth_clients_created ON oauth_clients(created_at);
CREATE INDEX IF NOT EXISTS mfa_challenges_expires ON mfa_challenges(expires_at);
