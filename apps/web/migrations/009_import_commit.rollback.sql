-- E02-S05 rollback: drop import commit tables (empty pre-data only).
-- FORBIDDEN after real import history exists.

ALTER TABLE background_job_results DROP CONSTRAINT IF EXISTS background_job_results_kind;
ALTER TABLE background_job_results ADD CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop', 'import-parsed'));

ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start', 'imports.parse'));

DROP POLICY IF EXISTS import_commit_batches_isolation ON import_commit_batches;
DROP TABLE IF EXISTS import_commit_batches;

DROP POLICY IF EXISTS review_decisions_isolation ON review_decisions;
DROP TABLE IF EXISTS review_decisions;

DROP POLICY IF EXISTS source_links_isolation ON source_links;
DROP TABLE IF EXISTS source_links;

DROP POLICY IF EXISTS transactions_isolation ON transactions;
DROP TABLE IF EXISTS transactions;

-- Remove accounts base_currency_code if added here (only if it was added by 009)
-- Since accounts may have it from a later migration, we don't drop it here.
-- If this is the first migration adding it, a later migration will handle it.