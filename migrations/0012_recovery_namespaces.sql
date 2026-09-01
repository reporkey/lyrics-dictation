ALTER TABLE device_memberships
ADD COLUMN recovery_namespace TEXT NOT NULL DEFAULT '';

UPDATE device_memberships
SET recovery_namespace = lower(hex(randomblob(16)))
WHERE recovery_namespace = '';
