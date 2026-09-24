-- E06-S04: flat what-if scenarios as deltas (never cloned books, never branches).
-- scenarios are named containers; scenario_overrides are typed hypothetical
-- inputs evaluated on top of the baseline model. R1 enforces flat scenarios:
-- parent_scenario_id is always NULL (branch trees are out of scope).
-- Composite tenant keys, FORCE RLS.

CREATE TABLE IF NOT EXISTS scenarios (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  name TEXT NOT NULL CONSTRAINT scenarios_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CONSTRAINT scenarios_status CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  parent_scenario_id UUID NULL CONSTRAINT scenarios_flat CHECK (parent_scenario_id IS NULL),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS scenarios_status_idx ON scenarios (workspace_id, status);

CREATE TABLE IF NOT EXISTS scenario_overrides (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  scenario_id UUID NOT NULL,
  override_type TEXT NOT NULL CONSTRAINT scenario_overrides_type CHECK (override_type IN ('ONE_TIME_EXPENSE', 'ONE_TIME_INCOME', 'RECURRING_EXPENSE_CHANGE', 'INCOME_CHANGE', 'GOAL_TARGET_CHANGE', 'GOAL_DATE_CHANGE', 'ASSUMPTION_OVERRIDE')),
  effective_from DATE NULL,
  effective_to DATE NULL CONSTRAINT scenario_overrides_period CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  payload JSONB NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, scenario_id) REFERENCES scenarios (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS scenario_overrides_scenario_idx ON scenario_overrides (workspace_id, scenario_id);

ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenarios FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scenarios_isolation ON scenarios;
CREATE POLICY scenarios_isolation ON scenarios
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE scenario_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scenario_overrides_isolation ON scenario_overrides;
CREATE POLICY scenario_overrides_isolation ON scenario_overrides
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
