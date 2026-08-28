CREATE TABLE session_start_locks (
  song_id TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_session_start_locks_expiry
  ON session_start_locks(expires_at);
