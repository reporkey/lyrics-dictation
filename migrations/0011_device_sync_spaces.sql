PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE data_spaces (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE device_memberships (
  identity_id TEXT PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  data_space_id TEXT NOT NULL REFERENCES data_spaces(id) ON DELETE CASCADE,
  public_device_id TEXT NOT NULL UNIQUE,
  device_label TEXT NOT NULL,
  joined_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_device_memberships_space
ON device_memberships(data_space_id, joined_at, public_device_id);

INSERT INTO data_spaces (id, version, mutation_token, created_at, updated_at)
SELECT id, 1, NULL, created_at, last_seen_at FROM identities;

INSERT INTO device_memberships
  (identity_id, data_space_id, public_device_id, device_label, joined_at)
SELECT
  id,
  id,
  lower(hex(randomblob(16))),
  upper(substr(hex(randomblob(4)), 1, 4)),
  created_at
FROM identities;

CREATE TABLE songs_device_sync (
  data_space_id TEXT NOT NULL REFERENCES data_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  source_text TEXT NOT NULL,
  study_text TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('plain', 'lrc')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  character_count INTEGER,
  PRIMARY KEY (data_space_id, id)
) STRICT;

INSERT INTO songs_device_sync
  (data_space_id, id, title, artist, source_text, study_text, source_kind,
   version, created_at, updated_at, character_count)
SELECT
  identity_id, id, title, artist, source_text, study_text, source_kind,
  version, created_at, updated_at, character_count
FROM songs;

CREATE TABLE sessions_device_sync (
  data_space_id TEXT NOT NULL,
  id TEXT NOT NULL,
  song_id TEXT NOT NULL,
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
  completed_at INTEGER,
  study_text TEXT,
  PRIMARY KEY (data_space_id, id),
  FOREIGN KEY (data_space_id, song_id)
    REFERENCES songs_device_sync(data_space_id, id) ON DELETE CASCADE
) STRICT;

INSERT INTO sessions_device_sync
  (data_space_id, id, song_id, status, draft_text, case_sensitive,
   correct_count, incorrect_count, extra_count, missing_count, version,
   started_at, updated_at, completed_at, study_text)
SELECT
  identity_id, id, song_id, status, draft_text, case_sensitive,
  correct_count, incorrect_count, extra_count, missing_count, version,
  started_at, updated_at, completed_at, study_text
FROM sessions;

CREATE TABLE session_start_locks_device_sync (
  data_space_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  intent_restart INTEGER NOT NULL DEFAULT 0 CHECK (intent_restart IN (0, 1)),
  result_session_id TEXT,
  PRIMARY KEY (data_space_id, song_id),
  FOREIGN KEY (data_space_id, song_id)
    REFERENCES songs_device_sync(data_space_id, id) ON DELETE CASCADE
) STRICT;

INSERT INTO session_start_locks_device_sync
  (data_space_id, song_id, owner_key, expires_at, intent_restart, result_session_id)
SELECT s.identity_id, l.song_id, l.owner_key, l.expires_at,
       l.intent_restart, l.result_session_id
FROM session_start_locks l
JOIN songs s ON s.id = l.song_id;

DROP TABLE session_start_locks;
DROP TABLE sessions;
DROP TABLE songs;

ALTER TABLE songs_device_sync RENAME TO songs;
ALTER TABLE sessions_device_sync RENAME TO sessions;
ALTER TABLE session_start_locks_device_sync RENAME TO session_start_locks;

CREATE INDEX idx_songs_space_updated
ON songs(data_space_id, updated_at DESC);

CREATE UNIQUE INDEX idx_sessions_one_active
ON sessions(data_space_id, song_id)
WHERE status = 'in_progress';

CREATE INDEX idx_sessions_space_recent
ON sessions(data_space_id, updated_at DESC, id DESC);

CREATE INDEX idx_sessions_song_recent
ON sessions(data_space_id, song_id, updated_at DESC, id DESC);

CREATE INDEX idx_session_start_locks_expiry
ON session_start_locks(expires_at);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  data_space_id TEXT NOT NULL REFERENCES data_spaces(id) ON DELETE CASCADE,
  created_by_identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  claimed_by_identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER
) STRICT;

CREATE INDEX idx_pairing_codes_space
ON pairing_codes(data_space_id);

CREATE INDEX idx_pairing_codes_expiry
ON pairing_codes(expires_at);
