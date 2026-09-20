-- E05-S01: Persist isolated artifact builds and immutable versions
-- Tenant-owned artifacts with composite (workspace_id, id) keys and FORCE RLS

CREATE TABLE artifacts (
    workspace_id UUID NOT NULL,
    id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    active_version_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ,
    PRIMARY KEY (workspace_id, id)
);

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON artifacts
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

CREATE INDEX artifacts_workspace_created_idx ON artifacts (workspace_id, created_at DESC);

CREATE TABLE artifact_versions (
    workspace_id UUID NOT NULL,
    id UUID NOT NULL,
    artifact_id UUID NOT NULL,
    manifest JSONB NOT NULL,
    source_hash BYTEA NOT NULL,
    build_hash BYTEA NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'building', 'ready', 'failed')),
    error_class TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id)
);

ALTER TABLE artifact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON artifact_versions
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

CREATE INDEX artifact_versions_artifact_created_idx ON artifact_versions (workspace_id, artifact_id, created_at DESC);
CREATE INDEX artifact_versions_artifact_status_idx ON artifact_versions (workspace_id, artifact_id, status) WHERE status IN ('ready', 'failed');

CREATE TABLE artifact_build_attempts (
    workspace_id UUID NOT NULL,
    id UUID NOT NULL,
    version_id UUID NOT NULL,
    attempt_no INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    lease_expires_at TIMESTAMPTZ,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'stale', 'cancelled')),
    error_class TEXT,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, version_id) REFERENCES artifact_versions (workspace_id, id)
);

ALTER TABLE artifact_build_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_build_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON artifact_build_attempts
    USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

CREATE INDEX artifact_build_attempts_version_idx ON artifact_build_attempts (workspace_id, version_id, attempt_no);