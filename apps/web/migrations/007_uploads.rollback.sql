-- E02-S03 rollback: removes the four staging tables and restores the S01
-- job/result allowlists (synthetic data only at this slice). Run
-- newest-first with the matching app version BEFORE any real import history
-- exists; after imports exist, forward-fix instead of running this file.
DROP POLICY IF EXISTS parsed_observations_isolation ON parsed_observations;
DROP TABLE IF EXISTS parsed_observations;
DROP POLICY IF EXISTS source_objects_isolation ON source_objects;
DROP TABLE IF EXISTS source_objects;
DROP POLICY IF EXISTS imports_isolation ON imports;
DROP TABLE IF EXISTS imports;
DROP POLICY IF EXISTS data_sources_isolation ON data_sources;
DROP TABLE IF EXISTS data_sources;
ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start'));
ALTER TABLE background_job_results DROP CONSTRAINT IF EXISTS background_job_results_kind;
ALTER TABLE background_job_results ADD CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop'));
DELETE FROM schema_migrations WHERE version = '007_uploads';
