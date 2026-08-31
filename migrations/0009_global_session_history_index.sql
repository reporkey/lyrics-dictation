CREATE INDEX IF NOT EXISTS idx_sessions_identity_recent
ON sessions(identity_id, updated_at DESC, id DESC);
