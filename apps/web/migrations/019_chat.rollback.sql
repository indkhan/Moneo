-- E04-S02 rollback: drops the pre-E04 chat tables and restores the jobs
-- type check. Forbidden once real conversations exist (forward-fix instead);
-- this rollback is for the synthetic pre-release slice and the tenancy
-- ordered-rollback test.
DROP TABLE IF EXISTS chat_activity;
DROP TABLE IF EXISTS chat_attempts;
DROP TABLE IF EXISTS chat_turns;
DROP TABLE IF EXISTS chat_threads;
ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start'));
