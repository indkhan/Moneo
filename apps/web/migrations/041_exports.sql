-- E08-S01 workspace export (architecture ##458-460; product R1 privacy row).
-- 1. Step-up evidence on app_sessions: verified Keycloak auth_time/acr
--    captured server-side at login (see auth.ts). NULL means no verified
--    step-up was observed; export creation/download require a fresh one and
--    missing claims fail closed. Never user-supplied, never logged.
-- 2. Job allowlists EXTEND the 038 union (never rewrite an older subset):
--    exports.build jobs + export-ready terminal results.
-- 3. export_packages holds one private encrypted bundle per idempotent
--    request: cutoff snapshot marker, 24h expiry, one-use download marker,
--    manifest/counts only (never finance bytes). The per-package data key
--    lives in this RLS-protected row; the object store holds ciphertext only.
-- Rollback (pre-release synthetic data only): drops the table, restores the
-- 038 allowlists and removes the step-up columns. Forbidden once real export
-- history exists without an export of its own.

ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS step_up_at TIMESTAMPTZ NULL;
ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS step_up_acr TEXT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_sessions_acr_len') THEN
    ALTER TABLE app_sessions ADD CONSTRAINT app_sessions_acr_len CHECK (step_up_acr IS NULL OR char_length(step_up_acr) BETWEEN 1 AND 64);
  END IF;
END $$;

ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start', 'imports.parse', 'imports.commit', 'chat.generate', 'artifact.build', 'deep-analysis.run', 'exports.build'));

ALTER TABLE background_job_results DROP CONSTRAINT IF EXISTS background_job_results_kind;
ALTER TABLE background_job_results ADD CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop', 'import-parsed', 'import-committed', 'artifact_build', 'deep-analysis-report', 'export-ready'));

CREATE TABLE IF NOT EXISTS export_packages (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  job_id UUID NOT NULL,
  requested_by UUID NOT NULL REFERENCES users (id),
  cutoff TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CONSTRAINT export_packages_status CHECK (status IN ('BUILDING', 'READY', 'FAILED_FINAL', 'EXPIRED')),
  object_key TEXT NULL CONSTRAINT export_packages_key_len CHECK (object_key IS NULL OR char_length(object_key) BETWEEN 1 AND 200),
  data_key BYTEA NULL CONSTRAINT export_packages_key_bytes CHECK (data_key IS NULL OR length(data_key) = 32),
  manifest JSONB NULL,
  section_counts JSONB NULL,
  downloaded_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  error_code TEXT NULL CONSTRAINT export_packages_error_len CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 64),
  error_summary TEXT NULL CONSTRAINT export_packages_summary_len CHECK (error_summary IS NULL OR char_length(error_summary) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, job_id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES background_jobs (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS export_packages_expiry_idx ON export_packages (expires_at) WHERE status = 'READY';

ALTER TABLE export_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_packages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS export_packages_isolation ON export_packages;
CREATE POLICY export_packages_isolation ON export_packages
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
