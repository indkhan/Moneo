-- E02-S02 rollback: removes the attempt history and the recovery columns
-- (synthetic data only at this slice). Run newest-first with the matching
-- app version BEFORE any real import history exists; after imports exist,
-- forward-fix instead of running this file.
DROP POLICY IF EXISTS background_job_attempts_isolation ON background_job_attempts;
DROP TABLE IF EXISTS background_job_attempts;
ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_generation_min;
ALTER TABLE background_jobs DROP COLUMN IF EXISTS attempt_generation;
ALTER TABLE background_jobs DROP COLUMN IF EXISTS lease_expires_at;
ALTER TABLE background_jobs DROP COLUMN IF EXISTS last_heartbeat_at;
ALTER TABLE background_jobs DROP COLUMN IF EXISTS progress_stage;
DELETE FROM schema_migrations WHERE version = '006_job_recovery';
