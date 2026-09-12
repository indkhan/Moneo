-- Epoch 2, Issue 2.4 — durable job and schedule schema.
--
-- PostgreSQL is job TRUTH; BullMQ/Redis is transport (Issues 2.5–2.7).
-- `background_jobs` holds one row per unit of work with an optional
-- `dedupe_key` making enqueue idempotent per (workspace, type).
-- `background_job_attempts` records every execution try, including crashes
-- (a `started` row with a stale heartbeat marks an orphaned attempt).
-- `scheduled_tasks` is GLOBAL reference data like `currencies`: schedules run
-- across workspaces, so it carries no RLS policy and no workspace column.
CREATE TABLE background_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  dedupe_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after timestamp with time zone NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamp with time zone,
  heartbeat_at timestamp with time zone,
  progress_stage text,
  progress_percent integer,
  cancelled_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT background_jobs_status_check CHECK (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT background_jobs_workspace_type_dedupe_uniq UNIQUE (workspace_id, type, dedupe_key)
);
--> statement-breakpoint
CREATE TABLE background_job_attempts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  job_id uuid NOT NULL REFERENCES background_jobs (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  status text NOT NULL DEFAULT 'started',
  error jsonb,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  heartbeat_at timestamp with time zone,
  finished_at timestamp with time zone,
  CONSTRAINT background_job_attempts_status_check CHECK (status in ('started', 'succeeded', 'failed')),
  CONSTRAINT background_job_attempts_job_number_uniq UNIQUE (job_id, attempt_number)
);
--> statement-breakpoint
CREATE TABLE scheduled_tasks (
  name text PRIMARY KEY,
  schedule text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at timestamp with time zone,
  next_run_at timestamp with time zone
);
--> statement-breakpoint
-- Pickup order for the dispatcher/worker: eligible jobs first, oldest first.
CREATE INDEX background_jobs_pickup_idx ON background_jobs USING btree (status, run_after, created_at);
--> statement-breakpoint
CREATE INDEX background_jobs_workspace_created_idx ON background_jobs USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX background_job_attempts_job_idx ON background_job_attempts USING btree (job_id, attempt_number);
--> statement-breakpoint
ALTER TABLE background_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE background_job_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE background_jobs, background_job_attempts TO moneo_app;
--> statement-breakpoint
-- scheduled_tasks is ops-owned reference data. Migration 0002's schema-wide
-- default privileges would otherwise hand the app role full write access, so
-- revoke first and grant read-only: the worker needs schedules to tick, but
-- only releases may change them.
REVOKE ALL ON TABLE scheduled_tasks FROM moneo_app;
--> statement-breakpoint
GRANT SELECT ON TABLE scheduled_tasks TO moneo_app;
--> statement-breakpoint
CREATE POLICY background_jobs_isolation ON background_jobs FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY background_job_attempts_isolation ON background_job_attempts FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
