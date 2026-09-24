-- E06-S01: projection settings and versioned financial assumptions.
-- Settings carry the workspace horizon/baseline/floor inputs; assumptions
-- are superseded, never mutated, so history stays reproducible.
-- Composite tenant keys, FORCE RLS, NULLIF-guarded context (033 precedent).

CREATE TABLE IF NOT EXISTS projection_settings (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  horizon_days INTEGER NOT NULL DEFAULT 30 CONSTRAINT projection_settings_horizon CHECK (horizon_days BETWEEN 1 AND 730),
  baseline_weeks INTEGER NOT NULL DEFAULT 8 CONSTRAINT projection_settings_baseline CHECK (baseline_weeks BETWEEN 1 AND 52),
  safety_floor_minor BIGINT NOT NULL DEFAULT 0 CONSTRAINT projection_settings_floor CHECK (safety_floor_minor >= 0),
  savings_included BOOLEAN NOT NULL DEFAULT FALSE,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id)
);

CREATE TABLE IF NOT EXISTS financial_assumptions (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  assumption_type TEXT NOT NULL CONSTRAINT financial_assumptions_type CHECK (assumption_type IN ('EXPECTED_INCOME', 'EXPECTED_VARIABLE_SPEND', 'EXPECTED_RECURRING_AMOUNT', 'ONE_TIME_EXPECTED_EXPENSE', 'ACCOUNT_BEHAVIOR', 'CUSTOM')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CONSTRAINT financial_assumptions_status CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'ARCHIVED')),
  valid_from DATE NOT NULL,
  valid_to DATE NULL CONSTRAINT financial_assumptions_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
  value JSONB NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '' CONSTRAINT financial_assumptions_scope_len CHECK (char_length(scope_key) BETWEEN 1 AND 300),
  origin TEXT NOT NULL DEFAULT 'USER' CONSTRAINT financial_assumptions_origin CHECK (origin IN ('USER', 'INFERRED', 'SYSTEM', 'IMPORTED')),
  confidence NUMERIC NULL,
  supersedes_id UUID NULL,
  actor_id UUID NULL,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, supersedes_id) REFERENCES financial_assumptions (workspace_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS financial_assumptions_lookup_idx ON financial_assumptions (workspace_id, status, assumption_type, valid_from);
CREATE INDEX IF NOT EXISTS financial_assumptions_scope_idx ON financial_assumptions (workspace_id, assumption_type, scope_key, status);

ALTER TABLE projection_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projection_settings_isolation ON projection_settings;
CREATE POLICY projection_settings_isolation ON projection_settings
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE financial_assumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_assumptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_assumptions_isolation ON financial_assumptions;
CREATE POLICY financial_assumptions_isolation ON financial_assumptions
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
