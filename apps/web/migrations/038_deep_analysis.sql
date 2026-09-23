-- E07-S01: one bounded initial Deep Analysis per workspace.
-- deep_analysis_runs owns the workspace-keyed initial-run claim (UNIQUE
-- workspace_id: exactly one initial run ever), the frozen data revision and
-- policy version, the batch window, bounded usage counters and the saved
-- report. Steps and findings are write-once evidence owned by the run.
-- Extends the job allowlists (never narrows): deep-analysis.run +
-- deep-analysis-report join the 032 union. Composite tenant keys, FORCE RLS
-- with the NULLIF guard (033 precedent). Rollback drops these pre-history
-- tables only and restores the 032 allowlists; forbidden once real analysis
-- history exists (see rollback file).

ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start', 'imports.parse', 'imports.commit', 'chat.generate', 'artifact.build', 'deep-analysis.run'));

ALTER TABLE background_job_results DROP CONSTRAINT IF EXISTS background_job_results_kind;
ALTER TABLE background_job_results ADD CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop', 'import-parsed', 'import-committed', 'artifact_build', 'deep-analysis-report'));

-- One initial run per workspace: UNIQUE(workspace_id) is the claim fence.
-- commit_ids records the coalesced batch (commits in the quiet window);
-- cutoff_at freezes evidence; report is the saved publish payload.
CREATE TABLE IF NOT EXISTS deep_analysis_runs (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  status TEXT NOT NULL CONSTRAINT deep_analysis_runs_status CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')),
  job_id UUID NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT deep_analysis_runs_attempts_min CHECK (attempt_count >= 0),
  data_revision TEXT NOT NULL DEFAULT '0' CONSTRAINT deep_analysis_runs_revision_len CHECK (char_length(data_revision) BETWEEN 1 AND 64),
  policy_version TEXT NOT NULL DEFAULT '1' CONSTRAINT deep_analysis_runs_policy_len CHECK (char_length(policy_version) BETWEEN 1 AND 32),
  cutoff_at TIMESTAMPTZ NULL,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_closed_at TIMESTAMPTZ NULL,
  commit_ids JSONB NOT NULL DEFAULT '[]'::jsonb CONSTRAINT deep_analysis_runs_commits_array CHECK (jsonb_typeof(commit_ids) = 'array'),
  dispatches_used INTEGER NOT NULL DEFAULT 0 CONSTRAINT deep_analysis_runs_dispatches_min CHECK (dispatches_used >= 0),
  tool_calls_used INTEGER NOT NULL DEFAULT 0 CONSTRAINT deep_analysis_runs_tools_min CHECK (tool_calls_used >= 0),
  tokens_reserved INTEGER NOT NULL DEFAULT 0 CONSTRAINT deep_analysis_runs_tokens_min CHECK (tokens_reserved >= 0),
  cost_reserved_minor TEXT NOT NULL DEFAULT '0' CONSTRAINT deep_analysis_runs_cost_len CHECK (char_length(cost_reserved_minor) BETWEEN 1 AND 64),
  progress_stage TEXT NOT NULL DEFAULT 'queued' CONSTRAINT deep_analysis_runs_stage_len CHECK (char_length(progress_stage) BETWEEN 1 AND 64),
  coverage_warnings JSONB NOT NULL DEFAULT '[]'::jsonb CONSTRAINT deep_analysis_runs_warnings_array CHECK (jsonb_typeof(coverage_warnings) = 'array'),
  report JSONB NULL,
  error_code TEXT NULL CONSTRAINT deep_analysis_runs_error_len CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 64),
  error_class TEXT NULL CONSTRAINT deep_analysis_runs_class_len CHECK (error_class IS NULL OR char_length(error_class) BETWEEN 1 AND 64),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id)
);

-- Checkpointed phase evidence: one row per completed phase. Evidence JSON
-- carries counts/ids/hashes only, never finance payloads beyond the saved
-- report's validated numbers.
CREATE TABLE IF NOT EXISTS deep_analysis_steps (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  run_id UUID NOT NULL,
  step TEXT NOT NULL CONSTRAINT deep_analysis_steps_name CHECK (step IN ('baseline', 'investigation', 'validation', 'publish')),
  status TEXT NOT NULL CONSTRAINT deep_analysis_steps_status CHECK (status IN ('ok', 'failed', 'skipped')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES deep_analysis_runs (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS deep_analysis_steps_run_idx ON deep_analysis_steps (workspace_id, run_id);

-- Saved findings: server-computed numbers (decimal-string minor units) plus
-- the evidence IDs that reproduce them. Provider prose never supplies a
-- metric: amount_minor/currency always come from shared-query evidence.
CREATE TABLE IF NOT EXISTS deep_analysis_findings (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  run_id UUID NOT NULL,
  kind TEXT NOT NULL CONSTRAINT deep_analysis_findings_kind CHECK (kind IN ('spending', 'income', 'recurring', 'goal', 'projection', 'coverage')),
  title TEXT NOT NULL CONSTRAINT deep_analysis_findings_title_len CHECK (char_length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL CONSTRAINT deep_analysis_findings_body_len CHECK (char_length(body) BETWEEN 1 AND 2000),
  amount_minor TEXT NULL CONSTRAINT deep_analysis_findings_amount_len CHECK (amount_minor IS NULL OR char_length(amount_minor) BETWEEN 1 AND 64),
  currency CHAR(3) NULL CONSTRAINT deep_analysis_findings_currency_fmt CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb CONSTRAINT deep_analysis_findings_evidence_array CHECK (jsonb_typeof(evidence) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES deep_analysis_runs (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS deep_analysis_findings_run_idx ON deep_analysis_findings (workspace_id, run_id);

ALTER TABLE deep_analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE deep_analysis_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deep_analysis_runs_isolation ON deep_analysis_runs;
CREATE POLICY deep_analysis_runs_isolation ON deep_analysis_runs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE deep_analysis_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE deep_analysis_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deep_analysis_steps_isolation ON deep_analysis_steps;
CREATE POLICY deep_analysis_steps_isolation ON deep_analysis_steps
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE deep_analysis_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE deep_analysis_findings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deep_analysis_findings_isolation ON deep_analysis_findings;
CREATE POLICY deep_analysis_findings_isolation ON deep_analysis_findings
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
