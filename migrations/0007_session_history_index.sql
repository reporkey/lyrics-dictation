CREATE INDEX IF NOT EXISTS idx_sessions_song_recent
ON sessions(identity_id, song_id, updated_at DESC, id DESC);
