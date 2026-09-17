-- E01-S05: AI data-access policy (§538). Workspace-owned exclusions with a
-- monotonically increasing policy version, plus dispatch permits that
-- snapshot eligible inputs. Composite keys per §27; FORCE RLS per §23.
-- Exclusions are deny-only in this slice (accounts only).

CREATE TABLE IF NOT EXISTS ai_policies (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  policy_version BIGINT NOT NULL DEFAULT 1 CONSTRAINT ai_policies_version_min CHECK (policy_version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_exclusions (
  workspace_id UUID NOT NULL,
  account_id UUID NOT NULL,
  reason TEXT NULL CONSTRAINT ai_exclusions_reason_len CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
  created_by UUID NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_dispatch_permits (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  policy_version BIGINT NOT NULL,
  eligible_account_ids JSONB NOT NULL,
  purpose TEXT NOT NULL CONSTRAINT ai_permits_purpose_len CHECK (char_length(purpose) BETWEEN 1 AND 120),
  status TEXT NOT NULL CONSTRAINT ai_permits_status CHECK (status IN ('QUEUED', 'DISPATCHED', 'INVALIDATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT ai_permits_ids_array CHECK (jsonb_typeof(eligible_account_ids) = 'array')
);

ALTER TABLE ai_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_policies_isolation ON ai_policies;
CREATE POLICY ai_policies_isolation ON ai_policies
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE ai_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_exclusions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_exclusions_isolation ON ai_exclusions;
CREATE POLICY ai_exclusions_isolation ON ai_exclusions
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE ai_dispatch_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_dispatch_permits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_permits_isolation ON ai_dispatch_permits;
CREATE POLICY ai_permits_isolation ON ai_dispatch_permits
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
