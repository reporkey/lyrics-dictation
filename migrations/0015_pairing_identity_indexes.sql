CREATE INDEX IF NOT EXISTS idx_pairing_codes_creator
ON pairing_codes(created_by_identity_id);

CREATE INDEX IF NOT EXISTS idx_pairing_codes_claimant
ON pairing_codes(claimed_by_identity_id);
