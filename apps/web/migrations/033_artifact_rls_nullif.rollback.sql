-- Rollback E05 033 NULLIF hardening (restores the 026/028/029 policy text).
-- Synthetic pre-release data only; policies only, no table changes.

DROP POLICY IF EXISTS workspace_isolation ON artifacts;
CREATE POLICY workspace_isolation ON artifacts
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

DROP POLICY IF EXISTS workspace_isolation ON artifact_versions;
CREATE POLICY workspace_isolation ON artifact_versions
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

DROP POLICY IF EXISTS workspace_isolation ON artifact_build_attempts;
CREATE POLICY workspace_isolation ON artifact_build_attempts
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

DROP POLICY IF EXISTS workspace_isolation ON artifact_runtime_grants;
CREATE POLICY workspace_isolation ON artifact_runtime_grants
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

DROP POLICY IF EXISTS workspace_isolation ON artifact_sdk_access_events;
CREATE POLICY workspace_isolation ON artifact_sdk_access_events
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

DROP POLICY IF EXISTS workspace_isolation ON artifact_state;
CREATE POLICY workspace_isolation ON artifact_state
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

DROP POLICY IF EXISTS workspace_isolation ON artifact_state_snapshots;
CREATE POLICY workspace_isolation ON artifact_state_snapshots
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

DROP POLICY IF EXISTS workspace_isolation ON artifact_state_migrations;
CREATE POLICY workspace_isolation ON artifact_state_migrations
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);
