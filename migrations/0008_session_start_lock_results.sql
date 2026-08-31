ALTER TABLE session_start_locks
ADD COLUMN intent_restart INTEGER NOT NULL DEFAULT 0
CHECK (intent_restart IN (0, 1));

ALTER TABLE session_start_locks
ADD COLUMN result_session_id TEXT;
