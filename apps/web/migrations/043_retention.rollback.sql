-- Rollback E08-S01c-L local retention. Synthetic pre-release data only.
-- FORBIDDEN once real retention history exists without an export: disable
-- the sweeper first. Additive migration: no other table, column, or policy
-- is touched by this rollback.

DROP TABLE IF EXISTS import_expiry_index;
DROP TABLE IF EXISTS export_expiry_index;
ALTER TABLE imports DROP COLUMN IF EXISTS retain_original;
