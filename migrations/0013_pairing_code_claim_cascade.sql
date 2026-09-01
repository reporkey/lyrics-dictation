PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE pairing_codes_claim_cascade (
  code_hash TEXT PRIMARY KEY,
  data_space_id TEXT NOT NULL REFERENCES data_spaces(id) ON DELETE CASCADE,
  created_by_identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  claimed_by_identity_id TEXT REFERENCES identities(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER
) STRICT;

INSERT INTO pairing_codes_claim_cascade
  (code_hash, data_space_id, created_by_identity_id, claimed_by_identity_id,
   created_at, expires_at, claimed_at)
SELECT
  code_hash, data_space_id, created_by_identity_id, claimed_by_identity_id,
  created_at, expires_at, claimed_at
FROM pairing_codes;

DROP TABLE pairing_codes;
ALTER TABLE pairing_codes_claim_cascade RENAME TO pairing_codes;

CREATE INDEX idx_pairing_codes_space
ON pairing_codes(data_space_id);

CREATE INDEX idx_pairing_codes_expiry
ON pairing_codes(expires_at);
