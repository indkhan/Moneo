-- Rollback E08-S01 workspace export. Synthetic pre-release data only.
-- FORBIDDEN once real export history exists without an export of its own:
-- disable export creation/download first, let READY packages expire (or
-- delete them through the expiry path), and never drop accepted packages
-- after external use without that export. Additive migration: no other
-- table, column, or policy is touched by this rollback.

DROP TABLE IF EXISTS export_packages;

ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start', 'imports.parse', 'imports.commit', 'chat.generate', 'artifact.build', 'deep-analysis.run'));

ALTER TABLE background_job_results DROP CONSTRAINT IF EXISTS background_job_results_kind;
ALTER TABLE background_job_results ADD CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop', 'import-parsed', 'import-committed', 'artifact_build', 'deep-analysis-report'));

ALTER TABLE app_sessions DROP CONSTRAINT IF EXISTS app_sessions_acr_len;
ALTER TABLE app_sessions DROP COLUMN IF EXISTS step_up_acr;
ALTER TABLE app_sessions DROP COLUMN IF EXISTS step_up_at;
