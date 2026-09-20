-- E05-S03: Runtime grants and access events for Finance SDK
-- Server-derived grants bound to user/workspace/artifact/version/policy revision/expiry

CREATE TABLE artifact_runtime_grants (
    workspace_id UUID NOT NULL,
    id UUID NOT NULL,
    artifact_id UUID NOT NULL,
    artifact_version_id UUID NOT NULL,
    user_id UUID NOT NULL,
    session_id UUID NOT NULL,
    permissions TEXT[] NOT NULL,
    data_revision BIGINT NOT NULL,
    policy_revision BIGINT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id),
    FOREIGN KEY (workspace_id, artifact_version_id) REFERENCES artifact_versions (workspace_id, id),
    FOREIGN KEY (user_id) REFERENCES users (id)
);

ALTER TABLE artifact_runtime_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_runtime_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON artifact_runtime_grants
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

CREATE INDEX artifact_runtime_grants_session_idx ON artifact_runtime_grants (workspace_id, session_id);
CREATE INDEX artifact_runtime_grants_artifact_idx ON artifact_runtime_grants (workspace_id, artifact_id, artifact_version_id);

CREATE TABLE artifact_sdk_access_events (
    workspace_id UUID NOT NULL,
    id UUID NOT NULL,
    grant_id UUID NOT NULL,
    method TEXT NOT NULL,
    args_json JSONB NOT NULL,
    result_rows INTEGER,
    result_bytes INTEGER,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'denied', 'quota_exceeded', 'error', 'revoked')),
    error_class TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, grant_id) REFERENCES artifact_runtime_grants (workspace_id, id)
);

ALTER TABLE artifact_sdk_access_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_sdk_access_events FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON artifact_sdk_access_events
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

CREATE INDEX artifact_sdk_access_events_grant_idx ON artifact_sdk_access_events (workspace_id, grant_id, created_at);