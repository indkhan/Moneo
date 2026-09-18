-- E02-S04 rollback: removes the mapping tables and the source-columns
-- capture (synthetic data only at this slice). Run newest-first with the
-- matching app version BEFORE any real mapping history exists; after mapping
-- history exists, forward-fix instead of running this file.
DROP POLICY IF EXISTS mapping_usage_isolation ON mapping_provider_usage;
DROP TABLE IF EXISTS mapping_provider_usage;
DROP POLICY IF EXISTS mapping_reservations_isolation ON mapping_provider_reservations;
DROP TABLE IF EXISTS mapping_provider_reservations;
DROP POLICY IF EXISTS mapping_proposals_isolation ON mapping_proposals;
DROP TABLE IF EXISTS mapping_proposals;
DROP POLICY IF EXISTS mapping_profiles_isolation ON mapping_profiles;
DROP TABLE IF EXISTS mapping_profiles;
ALTER TABLE imports DROP COLUMN IF EXISTS source_columns;
DELETE FROM schema_migrations WHERE version = '008_mapping';
