-- E02-S01 rollback: removes the three job/outbox tables, the dispatch
-- index and the immutability trigger (synthetic data only at this slice).
-- Run only with the matching app version BEFORE any real import history
-- exists; after imports exist, forward-fix instead of running this file.
DROP TRIGGER IF EXISTS background_job_results_immutable ON background_job_results;
DROP FUNCTION IF EXISTS reject_job_result_mutation();
DROP POLICY IF EXISTS outbox_events_isolation ON outbox_events;
DROP TABLE IF EXISTS outbox_events;
DROP POLICY IF EXISTS background_job_results_isolation ON background_job_results;
DROP TABLE IF EXISTS background_job_results;
DROP TABLE IF EXISTS job_dispatch_index;
DROP POLICY IF EXISTS background_jobs_isolation ON background_jobs;
DROP TABLE IF EXISTS background_jobs;
DROP INDEX IF EXISTS outbox_events_unpublished_idx;
DELETE FROM schema_migrations WHERE version = '005_jobs';
