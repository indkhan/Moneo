-- Rollback E07-S01 initial Deep Analysis (pre-history only).
-- Drops the run/step/finding tables and restores the 032 job allowlists.
-- Procedure: disable the commit trigger path and the deep-analysis worker
-- first, drain or cancel outstanding deep-analysis.run attempts, then apply
-- this file. FORBIDDEN once real analysis history exists (published reports
-- are user-visible evidence; dropping them then destroys audit state).

DROP TABLE IF EXISTS deep_analysis_findings;
DROP TABLE IF EXISTS deep_analysis_steps;
DROP TABLE IF EXISTS deep_analysis_runs;

ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start', 'imports.parse', 'imports.commit', 'chat.generate', 'artifact.build'));

ALTER TABLE background_job_results DROP CONSTRAINT IF EXISTS background_job_results_kind;
ALTER TABLE background_job_results ADD CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop', 'import-parsed', 'import-committed', 'artifact_build'));
