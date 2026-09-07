-- Schema-drift baseline for connector-discovered assets. Stores a sha256
-- fingerprint of the column set reported by the last scan; the next scan
-- compares against it to detect a column added / removed / retyped. Nullable,
-- no default — existing rows have no baseline until their next scan reports
-- columns, at which point the first fingerprint is established (never itself
-- treated as drift).
ALTER TABLE "data_assets" ADD COLUMN "schemaFingerprint" TEXT;
