PRAGMA foreign_keys = ON;

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_identities_expiry ON identities(expires_at);

CREATE TABLE settings (
  identity_id TEXT PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE songs (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  source_text TEXT NOT NULL,
  study_text TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('plain', 'lrc')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_songs_owner_updated ON songs(identity_id, updated_at DESC);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  draft_text TEXT NOT NULL DEFAULT '',
  case_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (case_sensitive IN (0, 1)),
  correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  incorrect_count INTEGER NOT NULL DEFAULT 0 CHECK (incorrect_count >= 0),
  extra_count INTEGER NOT NULL DEFAULT 0 CHECK (extra_count >= 0),
  missing_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;

CREATE UNIQUE INDEX idx_sessions_one_active
  ON sessions(identity_id, song_id)
  WHERE status = 'in_progress';
CREATE INDEX idx_sessions_owner_recent ON sessions(identity_id, updated_at DESC);

CREATE TABLE idempotency_keys (
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, operation, key)
) STRICT;

CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);

CREATE TABLE rate_limits (
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (identity_id, bucket)
) STRICT;
