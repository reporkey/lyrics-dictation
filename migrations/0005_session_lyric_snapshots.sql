ALTER TABLE sessions ADD COLUMN study_text TEXT;

UPDATE sessions
SET study_text = (
  SELECT songs.study_text
  FROM songs
  WHERE songs.id = sessions.song_id
    AND songs.identity_id = sessions.identity_id
)
WHERE study_text IS NULL;
