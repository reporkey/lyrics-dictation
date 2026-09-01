ALTER TABLE device_memberships
ADD COLUMN device_platform TEXT;

ALTER TABLE device_memberships
ADD COLUMN device_browser TEXT;

ALTER TABLE device_memberships
ADD COLUMN browser_major_version TEXT;

ALTER TABLE device_memberships
ADD COLUMN device_type TEXT NOT NULL DEFAULT 'unknown'
CHECK (device_type IN ('desktop', 'phone', 'tablet', 'unknown'));
