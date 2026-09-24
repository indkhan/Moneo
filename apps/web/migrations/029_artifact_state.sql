-- E05-S04: Persist local state with atomic activation and revert

CREATE TABLE artifact_state (
    workspace_id UUID NOT NULL,
    artifact_id UUID NOT NULL,
    version_id UUID NOT NULL,
    schema_version INTEGER NOT NULL,
    state JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, artifact_id),
    FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES artifact_versions (workspace_id, id)
);

ALTER TABLE artifact_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_state FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON artifact_state
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

CREATE TABLE artifact_state_snapshots (
    workspace_id UUID NOT NULL,
    id UUID NOT NULL,
    artifact_id UUID NOT NULL,
    version_id UUID NOT NULL,
    schema_version INTEGER NOT NULL,
    state JSONB NOT NULL,
    migration_chain JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES artifact_versions (workspace_id, id)
);

ALTER TABLE artifact_state_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_state_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON artifact_state_snapshots
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

CREATE INDEX artifact_state_snapshots_artifact_idx ON artifact_state_snapshots (workspace_id, artifact_id, created_at DESC);

-- Declarative migration operations table for state migrations
CREATE TABLE artifact_state_migrations (
    workspace_id UUID NOT NULL,
    id UUID NOT NULL,
    artifact_id UUID NOT NULL,
    from_version_id UUID NOT NULL,
    to_version_id UUID NOT NULL,
    operations JSONB NOT NULL, -- array of {type: "rename"|"remove"|"set-default", path: string, new_path?: string, default?: any}
    status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'failed')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at TIMESTAMPTZ,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id),
    FOREIGN KEY (workspace_id, from_version_id) REFERENCES artifact_versions (workspace_id, id),
    FOREIGN KEY (workspace_id, to_version_id) REFERENCES artifact_versions (workspace_id, id)
);

ALTER TABLE artifact_state_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_state_migrations FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON artifact_state_migrations
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);