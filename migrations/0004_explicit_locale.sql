ALTER TABLE settings
ADD COLUMN locale_explicit INTEGER NOT NULL DEFAULT 0
CHECK (locale_explicit IN (0, 1));
