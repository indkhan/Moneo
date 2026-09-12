-- Epoch 2, Issue 2.1 — command / audit / outbox schema.
--
-- `command_operations` holds one row per typed domain command. The
-- UNIQUE(workspace_id, command_name, idempotency_key) constraint IS the
-- idempotency claim: the first insert wins, a replay conflicts and re-reads
-- the stored result instead of re-mutating (Issue 2.2 executor).
-- `audit_events` is the immutable domain audit trail (Epoch 5 history UI).
-- `outbox_events` is the transactional outbox: handlers insert rows in the
-- SAME transaction as the business mutation, and the dispatcher (Issue 2.5)
-- claims them with FOR UPDATE SKIP LOCKED.
-- All three tables are tenant-bound: RLS policies pin every app-role read and
-- write to `app.current_workspace`, exactly like the Epoch 1 tables.
CREATE TABLE command_operations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  command_name text NOT NULL,
  idempotency_key text NOT NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  expected_version bigint,
  resulting_version bigint,
  status text NOT NULL DEFAULT 'succeeded',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT command_operations_workspace_command_key_uniq UNIQUE (workspace_id, command_name, idempotency_key),
  CONSTRAINT command_operations_status_check CHECK (status in ('claimed', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  command_operation_id uuid REFERENCES command_operations (id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  published_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_status_check CHECK (status in ('pending', 'claimed', 'published', 'failed'))
);
--> statement-breakpoint
CREATE INDEX command_operations_workspace_created_idx ON command_operations USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX audit_events_workspace_entity_idx ON audit_events USING btree (workspace_id, entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX audit_events_workspace_created_idx ON audit_events USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX outbox_events_dispatch_idx ON outbox_events USING btree (status, next_attempt_at, created_at);
--> statement-breakpoint
CREATE INDEX outbox_events_workspace_created_idx ON outbox_events USING btree (workspace_id, created_at);
--> statement-breakpoint
ALTER TABLE command_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE command_operations, audit_events, outbox_events TO moneo_app;
--> statement-breakpoint
-- Commands: strictly bound to the current workspace on read and write. The
-- executor always runs inside `withWorkspaceTransaction`, so the claim insert
-- carries the same workspace as the context; the UNIQUE constraint then
-- scopes each idempotency key per workspace (A and B can reuse one key).
CREATE POLICY command_operations_isolation ON command_operations FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
-- Audit trail: insert-only by convention. No UPDATE/DELETE policy is granted,
-- so the app role can append and read within its workspace but never rewrite
-- history (owner role retains full access for ops/forensics).
CREATE POLICY audit_events_isolation ON audit_events FOR SELECT TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY audit_events_insert_scoped ON audit_events FOR INSERT TO moneo_app
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
-- Outbox: the executor inserts within its workspace; the dispatcher updates
-- (claim/publish) only rows of the workspace it runs for.
CREATE POLICY outbox_events_isolation ON outbox_events FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
