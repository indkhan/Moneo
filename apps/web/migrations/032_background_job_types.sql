-- E05-S07: Restore background job allowlists clobbered by 019/027.
-- 019_chat and 027_artifact_build_job rewrote whole CHECK allowlists and
-- silently dropped imports.parse/imports.commit (background_jobs_type) and
-- import-parsed/import-committed (background_job_results_kind), so any
-- fully-migrated database rejects the E02 upload, parse and commit legs
-- (caught by the E05 exit journey). This restores both full unions; future
-- changes must EXTEND these lists, never rewrite them from an older
-- migration's subset.

ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start', 'imports.parse', 'imports.commit', 'chat.generate', 'artifact.build'));

ALTER TABLE background_job_results DROP CONSTRAINT IF EXISTS background_job_results_kind;
ALTER TABLE background_job_results ADD CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop', 'import-parsed', 'import-committed', 'artifact_build'));
