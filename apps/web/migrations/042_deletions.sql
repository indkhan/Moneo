-- E08-S01b durable deletion (architecture ##461-464; product R1 privacy row).
-- 1. workspaces.deletion_requested_at is the immediate-revocation marker for
--    workspace-scope purges: withTenant denies tombstoned workspaces at every
--    trust boundary (uniform tenant denial, no oracle).
-- 2. deletion_requests tracks one idempotent coordinator run per
--    (workspace, scope, subject) behind command_operations idempotency, with
--    a per-table checkpoint so repeat/crash resumes to one completion.
-- 3. deletion_tombstones is the protected ledger outside ordinary restorable
--    tenant data (arch 464): opaque subject refs, scope, timestamps and a
--    retention basis code only — no finance, no personal content. No RLS by
--    the same rationale as job_dispatch_index (UUIDs/codes only); S02 replays
--    it after restore. Never delete from it in normal flows.
-- Rollback (pre-release synthetic data only): drops the tables and the
-- marker column. Forbidden once real deletion history exists: rollback can
-- restore code but never reverse purged data.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ NULL;

-- E08-S01b narrows the E02-S01 immutable-results trigger: ordinary UPDATE
-- and DELETE stay forbidden, but DELETE passes while an authorized deletion
-- request for the same workspace is active (the coordinator purges effects
-- as part of privacy erasure). The workspace setting is the same RLS
-- context every tenant write already carries; no other flow can satisfy the
-- predicate without an authorized request row.
CREATE OR REPLACE FUNCTION reject_job_result_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM deletion_requests
    WHERE workspace_id = OLD.workspace_id AND status IN ('PENDING', 'IN_PROGRESS', 'FAILED')
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'background_job_results is immutable (E02-S01)';
  RETURN NULL;
END;
$$;

CREATE TABLE IF NOT EXISTS deletion_requests (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  scope TEXT NOT NULL CONSTRAINT deletion_requests_scope CHECK (scope IN ('workspace', 'identity')),
  subject_user_id UUID NOT NULL REFERENCES users (id),
  requested_by UUID NOT NULL REFERENCES users (id),
  successor_user_id UUID NULL REFERENCES users (id),
  status TEXT NOT NULL CONSTRAINT deletion_requests_status CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETE', 'FAILED')),
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT NULL CONSTRAINT deletion_requests_error_len CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 64),
  error_summary TEXT NULL CONSTRAINT deletion_requests_summary_len CHECK (error_summary IS NULL OR char_length(error_summary) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS deletion_requests_subject_idx ON deletion_requests (subject_user_id);

ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deletion_requests_isolation ON deletion_requests;
CREATE POLICY deletion_requests_isolation ON deletion_requests
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

CREATE TABLE IF NOT EXISTS deletion_tombstones (
  id UUID NOT NULL PRIMARY KEY,
  subject_kind TEXT NOT NULL CONSTRAINT deletion_tombstones_kind CHECK (subject_kind IN ('workspace', 'identity')),
  subject_ref UUID NOT NULL,
  workspace_ref UUID NULL,
  scope TEXT NOT NULL CONSTRAINT deletion_tombstones_scope CHECK (scope IN ('workspace', 'identity')),
  request_id UUID NOT NULL UNIQUE,
  basis TEXT NOT NULL CONSTRAINT deletion_tombstones_basis_len CHECK (char_length(basis) BETWEEN 1 AND 64),
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deletion_tombstones_subject_idx ON deletion_tombstones (subject_ref);
