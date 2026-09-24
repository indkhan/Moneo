-- E04-S07: AI evaluation fixtures and results storage (product evidence-first AI;
-- architecture eval/provider/privacy gates; all E04 stories). Versioned synthetic
-- evaluation fixtures/results contain no secrets or personal data. Deterministic
-- protocol tests in normal CI; bounded live-model qualification separately.
-- Composite keys per §27; FORCE RLS per §23.

-- Frozen rubric/dataset metadata (one row per frozen evaluation run).
CREATE TABLE IF NOT EXISTS ai_eval_runs (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  rubric_version TEXT NOT NULL CONSTRAINT ai_eval_runs_rubric_len CHECK (char_length(rubric_version) BETWEEN 1 AND 64),
  dataset_version TEXT NOT NULL CONSTRAINT ai_eval_runs_dataset_len CHECK (char_length(dataset_version) BETWEEN 1 AND 64),
  model_identifier TEXT NOT NULL CONSTRAINT ai_eval_runs_model_len CHECK (char_length(model_identifier) BETWEEN 1 AND 200),
  route_class TEXT NOT NULL CONSTRAINT ai_eval_runs_route CHECK (route_class IN ('development', 'production')),
  prompt_version TEXT NOT NULL CONSTRAINT ai_eval_runs_prompt_len CHECK (char_length(prompt_version) BETWEEN 1 AND 64),
  tool_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'running' CONSTRAINT ai_eval_runs_status CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  PRIMARY KEY (workspace_id, id)
);

-- Individual test case results (one row per case per run).
CREATE TABLE IF NOT EXISTS ai_eval_cases (
  workspace_id UUID NOT NULL,
  run_id UUID NOT NULL,
  case_id UUID NOT NULL,
  category TEXT NOT NULL CONSTRAINT ai_eval_cases_category CHECK (category IN ('numerical_grounding', 'evidence_completeness', 'abstention_missing_coverage', 'exclusions_tenant_hostile', 'tool_selection', 'action_consent')),
  expected_output JSONB NOT NULL,
  actual_output JSONB NULL,
  passed BOOLEAN NULL,
  score NUMERIC(5,4) NULL, -- 0.0000 to 1.0000
  latency_ms INTEGER NULL,
  input_tokens INTEGER NULL,
  output_tokens INTEGER NULL,
  error_class TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id, case_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES ai_eval_runs (workspace_id, id) ON DELETE CASCADE
);

-- Aggregate summary per run (computed at completion).
CREATE TABLE IF NOT EXISTS ai_eval_summaries (
  workspace_id UUID NOT NULL,
  run_id UUID NOT NULL,
  total_cases INTEGER NOT NULL,
  passed_cases INTEGER NOT NULL,
  failed_cases INTEGER NOT NULL,
  overall_score NUMERIC(5,4) NULL,
  numerical_grounding_score NUMERIC(5,4) NULL,
  evidence_completeness_score NUMERIC(5,4) NULL,
  abstention_score NUMERIC(5,4) NULL,
  exclusions_score NUMERIC(5,4) NULL,
  tool_selection_score NUMERIC(5,4) NULL,
  action_consent_score NUMERIC(5,4) NULL,
  avg_latency_ms INTEGER NULL,
  total_input_tokens INTEGER NULL,
  total_output_tokens INTEGER NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, run_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES ai_eval_runs (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE ai_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_eval_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_eval_runs_isolation ON ai_eval_runs;
CREATE POLICY ai_eval_runs_isolation ON ai_eval_runs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE ai_eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_eval_cases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_eval_cases_isolation ON ai_eval_cases;
CREATE POLICY ai_eval_cases_isolation ON ai_eval_cases
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE ai_eval_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_eval_summaries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_eval_summaries_isolation ON ai_eval_summaries;
CREATE POLICY ai_eval_summaries_isolation ON ai_eval_summaries
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);