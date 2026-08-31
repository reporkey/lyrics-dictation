UPDATE sessions
SET completed_at = updated_at
WHERE status = 'abandoned' AND completed_at IS NULL;
