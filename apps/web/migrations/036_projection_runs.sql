-- E06-S03: projection runs, points, and events.
-- Immutable runs with input hash idempotency; daily points per case/scope;
-- events for explainability. FORCE RLS, composite tenant keys.

CREATE TABLE IF NOT EXISTS projection_runs (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  method TEXT NOT NULL DEFAULT 'SCENARIO_CASES' CONSTRAINT projection_runs_method CHECK (method = 'SCENARIO_CASES'),
  engine_version TEXT NOT NULL,
  scenario_id UUID NULL,
  horizon_start DATE NOT NULL,
  horizon_end DATE NOT NULL,
  base_currency CHAR(3) NOT NULL CONSTRAINT projection_runs_base_ccy CHECK (base_currency ~ '^[A-Z]{3}$'),
  input_hash TEXT NOT NULL,
  inputs JSONB NOT NULL,
  coverage JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CONSTRAINT projection_runs_status CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, input_hash, scenario_id)
);
CREATE INDEX IF NOT EXISTS projection_runs_hash_idx ON projection_runs (workspace_id, input_hash, scenario_id);
CREATE INDEX IF NOT EXISTS projection_runs_date_idx ON projection_runs (workspace_id, horizon_start, horizon_end);

CREATE TABLE IF NOT EXISTS projection_points (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  case_name TEXT NOT NULL CONSTRAINT projection_points_case CHECK (case_name IN ('EXPECTED', 'CONSERVATIVE', 'OPTIMISTIC')),
  scope TEXT NOT NULL, -- 'TOTAL' or account UUID
  point_date DATE NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency_code CHAR(3) NOT NULL CONSTRAINT projection_points_ccy CHECK (currency_code ~ '^[A-Z]{3}$'),
  PRIMARY KEY (workspace_id, run_id, case_name, scope, point_date),
  FOREIGN KEY (workspace_id, run_id) REFERENCES projection_runs (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS projection_points_run_idx ON projection_points (workspace_id, run_id, case_name, point_date);

CREATE TABLE IF NOT EXISTS projection_events (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  run_id UUID NOT NULL,
  event_date DATE NOT NULL,
  event_type TEXT NOT NULL CONSTRAINT projection_events_type CHECK (event_type IN ('SALARY', 'RENT', 'RECURRING_PAYMENT', 'VARIABLE_SPEND', 'GOAL_CONTRIBUTION', 'SCENARIO_OVERRIDE', 'PLANNED_EVENT', 'TRANSFER')),
  direction TEXT NULL CONSTRAINT projection_events_dir CHECK (direction IS NULL OR direction IN ('INFLOW', 'OUTFLOW')),
  amount_minor BIGINT NULL,
  currency_code CHAR(3) NULL CONSTRAINT projection_events_ccy CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  account_scope TEXT NULL, -- 'TOTAL' or account UUID
  label TEXT NOT NULL,
  source_refs JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES projection_runs (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS projection_events_run_idx ON projection_events (workspace_id, run_id, event_date);

ALTER TABLE projection_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projection_runs_isolation ON projection_runs;
CREATE POLICY projection_runs_isolation ON projection_runs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE projection_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_points FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projection_points_isolation ON projection_points;
CREATE POLICY projection_points_isolation ON projection_points
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE projection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projection_events_isolation ON projection_events;
CREATE POLICY projection_events_isolation ON projection_events
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);