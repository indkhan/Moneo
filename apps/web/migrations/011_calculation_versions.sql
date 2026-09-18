-- E03-S02: calculate exact cash and spending semantics.
-- Immutable calculation version metadata.
-- Pure calculation functions live in application code; this table stores
-- versioned evidence of calculation inputs/results for audit/reproducibility.

CREATE TABLE IF NOT EXISTS calculation_versions (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  version BIGINT NOT NULL DEFAULT 1,
  inputs_hash TEXT NOT NULL, -- SHA256 of canonicalized calculation inputs
  results_hash TEXT NOT NULL, -- SHA256 of canonicalized calculation results
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, version)
);
CREATE INDEX IF NOT EXISTS calculation_versions_created_idx ON calculation_versions (workspace_id, created_at DESC);

-- RLS policies: strict workspace equality
ALTER TABLE calculation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE calculation_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calculation_versions_isolation ON calculation_versions;
CREATE POLICY calculation_versions_isolation ON calculation_versions
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);