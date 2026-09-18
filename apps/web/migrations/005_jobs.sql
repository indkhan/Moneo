-- E02-S01: durable jobs + outbox dispatch (architecture ##60-62, 67-69,
-- 176-189, 215). PostgreSQL is durable truth; BullMQ is at-least-once
-- transport. Accept writes command_operations + background_jobs +
-- outbox_events + job_dispatch_index in ONE tenant transaction before BullMQ
-- ever sees the job.
--
-- Why job_dispatch_index carries NO RLS: FORCE RLS correctly forbids every
-- unscoped read, so the system-side dispatcher and worker need a narrow
-- discovery path to find (workspace, job) pairs. This index holds ONLY
-- random UUIDs (workspace/job/outbox/actor ids, no payload, no finance, no
-- secrets) — enumerating it reveals nothing without membership plus FORCE
-- RLS on the real tables, exactly like the un-RLS'd users identity anchor
-- (see 002_tenancy.sql). A schema-guard test fails if any non-UUID column is
-- added. Dispatcher/worker domain work always re-enters withTenant with the
-- recorded accepting member, so membership is enforced at every boundary and
-- ordinary workers get no general bypass. S02 owns attempts/checkpoints/
-- cancel; S03+ own file rows.
-- Rollback drops these empty pre-E02 tables only; forbidden after real
-- import history exists (see rollback file).

CREATE TABLE IF NOT EXISTS background_jobs (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  job_type TEXT NOT NULL CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start')),
  job_version TEXT NOT NULL DEFAULT '1' CONSTRAINT background_jobs_version_len CHECK (char_length(job_version) BETWEEN 1 AND 32),
  status TEXT NOT NULL CONSTRAINT background_jobs_status CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED_FINAL', 'CANCEL_REQUESTED', 'CANCELLED')),
  deduplication_key TEXT NULL CONSTRAINT background_jobs_dedup_len CHECK (deduplication_key IS NULL OR char_length(deduplication_key) BETWEEN 1 AND 200),
  command_operation_id UUID NULL,
  input_ref JSONB NOT NULL,
  result_ref JSONB NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT background_jobs_attempts_min CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CONSTRAINT background_jobs_max_attempts CHECK (max_attempts BETWEEN 1 AND 10),
  cancel_requested_at TIMESTAMPTZ NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  error_code TEXT NULL,
  error_summary TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, deduplication_key),
  FOREIGN KEY (workspace_id, command_operation_id) REFERENCES command_operations (workspace_id, id) ON DELETE SET NULL
);

-- Immutable synthetic business effect for the S01 slice: exactly one row per
-- job, never updated or deleted by application code (trigger enforces it).
CREATE TABLE IF NOT EXISTS background_job_results (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  background_job_id UUID NOT NULL,
  result_kind TEXT NOT NULL CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, background_job_id),
  FOREIGN KEY (workspace_id, background_job_id) REFERENCES background_jobs (workspace_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION reject_job_result_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'background_job_results is immutable (E02-S01)';
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS background_job_results_immutable ON background_job_results;
CREATE TRIGGER background_job_results_immutable
  BEFORE UPDATE OR DELETE ON background_job_results
  FOR EACH ROW EXECUTE FUNCTION reject_job_result_mutation();

CREATE TABLE IF NOT EXISTS outbox_events (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  event_type TEXT NOT NULL CONSTRAINT outbox_events_type CHECK (event_type IN ('job.ready')),
  aggregate_type TEXT NULL,
  aggregate_id UUID NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT outbox_events_attempts_min CHECK (attempt_count >= 0),
  last_error TEXT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS outbox_events_unpublished_idx ON outbox_events (available_at, created_at) WHERE published_at IS NULL;

-- Narrow dispatch discovery: one row per active job, UUIDs only. Written in
-- the same accept transaction as the job/outbox rows; deleted when the job
-- reaches a terminal state. See header note for why RLS is intentionally
-- absent here (and the schema-guard test that keeps it ID-only).
CREATE TABLE IF NOT EXISTS job_dispatch_index (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  job_id UUID NOT NULL,
  outbox_id UUID NOT NULL,
  accepted_by UUID NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, job_id),
  UNIQUE (job_id),
  UNIQUE (workspace_id, outbox_id)
);

ALTER TABLE background_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS background_jobs_isolation ON background_jobs;
CREATE POLICY background_jobs_isolation ON background_jobs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE background_job_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_job_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS background_job_results_isolation ON background_job_results;
CREATE POLICY background_job_results_isolation ON background_job_results
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_events_isolation ON outbox_events;
CREATE POLICY outbox_events_isolation ON outbox_events
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
