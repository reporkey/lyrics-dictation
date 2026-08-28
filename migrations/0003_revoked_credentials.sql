CREATE TABLE revoked_credentials (
  credential_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_revoked_credentials_expiry
  ON revoked_credentials(expires_at);
