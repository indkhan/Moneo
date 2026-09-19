-- E03-S04: Freeze calculation evidence and invalidate derived reads.
-- Add workspace data revision for coarse invalidation of derived reads.
-- Extend calculation_versions with bump command support.

-- Workspace data revision: coarse invalidation token for derived reads.
-- Bumped when any calculation-relevant data changes (transactions, balances, rates, categories).
-- Consumers (queries, AI tools) include this revision in cache keys; a change invalidates cached derived reads.
CREATE TABLE IF NOT EXISTS workspace_data_revision (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id)
);

-- RLS policies: strict workspace equality
ALTER TABLE workspace_data_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_data_revision FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_data_revision_isolation ON workspace_data_revision;
CREATE POLICY workspace_data_revision_isolation ON workspace_data_revision
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

-- Ensure calculation_versions has a bump command trigger (version is managed by command)
-- No schema change needed; calculation_versions already exists from 011.

-- RLS already exists on calculation_versions from 011.

-- Trigger function to bump workspace_data_revision on calculation-relevant changes
-- This is called from commands that modify transactions, balances, rates, categories, etc.
-- For now, the bump is done explicitly by the command; a trigger could be added later if needed.