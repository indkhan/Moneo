-- Epoch 3, Issue 3.1 — source ingestion schema.
--
-- Raw source layer: file bytes stay in quarantine storage (Issue 3.2), parsed
-- rows land here, canonical finance state (Epoch 4) derives from these rows
-- WITHOUT deleting them. UNIQUE(workspace_id, idempotency_key) on `imports`
-- is the re-submit claim (Issue 3.6). Partial-uniqueness needs are met by
-- plain UNIQUE(a, b) with a nullable b: PostgreSQL treats NULLs as distinct,
-- so keyless CSV rows coexist while a repeated stable external id collides.
-- File hashes are deliberately NOT unique: re-importing the same bytes with a
-- newer parser or on purpose must stay possible (Issue 3.8 warns, never blocks).
-- Every table is tenant-bound with the standard workspace_isolation RLS policy.
CREATE TABLE data_sources (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  type text NOT NULL,
  provider text,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  archived_at timestamp with time zone,
  CONSTRAINT data_sources_status_check CHECK (status in ('active', 'archived', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE imports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  data_source_id uuid NOT NULL REFERENCES data_sources (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  file_name text,
  file_sha256 text,
  object_storage_key text,
  parser_version text NOT NULL DEFAULT 'v1',
  status text NOT NULL DEFAULT 'pending',
  row_count integer,
  new_count integer,
  duplicate_count integer,
  review_count integer,
  error_count integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT imports_workspace_idempotency_uniq UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT imports_status_check CHECK (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE source_accounts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  data_source_id uuid NOT NULL REFERENCES data_sources (id) ON DELETE CASCADE,
  external_id text,
  stable_source_key text,
  display_name text,
  official_name text,
  currency_code text,
  raw_type text,
  raw_subtype text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  removed_at timestamp with time zone,
  CONSTRAINT source_accounts_source_external_uniq UNIQUE (data_source_id, external_id),
  CONSTRAINT source_accounts_source_stable_uniq UNIQUE (data_source_id, stable_source_key)
);
--> statement-breakpoint
CREATE TABLE source_transactions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  data_source_id uuid NOT NULL REFERENCES data_sources (id) ON DELETE CASCADE,
  source_account_id uuid REFERENCES source_accounts (id) ON DELETE SET NULL,
  external_id text,
  stable_source_key text,
  current_status text NOT NULL DEFAULT 'observed',
  pending_source_transaction_id uuid,
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  removed_at timestamp with time zone,
  latest_observation_id uuid,
  CONSTRAINT source_transactions_source_external_uniq UNIQUE (data_source_id, external_id),
  CONSTRAINT source_transactions_source_stable_uniq UNIQUE (data_source_id, stable_source_key),
  CONSTRAINT source_transactions_status_check CHECK (current_status in ('observed', 'pending_review', 'matched', 'removed'))
);
--> statement-breakpoint
CREATE TABLE source_transaction_observations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  source_transaction_id uuid NOT NULL REFERENCES source_transactions (id) ON DELETE CASCADE,
  import_id uuid REFERENCES imports (id) ON DELETE SET NULL,
  row_number integer,
  observation_type text NOT NULL DEFAULT 'file_row',
  observed_at timestamp with time zone NOT NULL DEFAULT now(),
  raw_hash text NOT NULL,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT source_observations_import_row_uniq UNIQUE (import_id, row_number),
  CONSTRAINT source_observations_type_check CHECK (observation_type in ('file_row', 'manual'))
);
--> statement-breakpoint
CREATE INDEX data_sources_workspace_status_idx ON data_sources USING btree (workspace_id, status);
--> statement-breakpoint
CREATE INDEX data_sources_workspace_created_idx ON data_sources USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX imports_workspace_created_idx ON imports USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX imports_data_source_idx ON imports USING btree (data_source_id);
--> statement-breakpoint
CREATE INDEX source_accounts_workspace_created_idx ON source_accounts USING btree (workspace_id, first_seen_at);
--> statement-breakpoint
CREATE INDEX source_accounts_data_source_idx ON source_accounts USING btree (data_source_id);
--> statement-breakpoint
CREATE INDEX source_transactions_workspace_created_idx ON source_transactions USING btree (workspace_id, first_seen_at);
--> statement-breakpoint
CREATE INDEX source_transactions_account_idx ON source_transactions USING btree (source_account_id);
--> statement-breakpoint
CREATE INDEX source_transactions_data_source_idx ON source_transactions USING btree (data_source_id);
--> statement-breakpoint
CREATE INDEX source_observations_transaction_observed_idx ON source_transaction_observations USING btree (source_transaction_id, observed_at DESC);
--> statement-breakpoint
CREATE INDEX source_observations_import_row_idx ON source_transaction_observations USING btree (import_id, row_number);
--> statement-breakpoint
ALTER TABLE data_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE source_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE source_transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE source_transaction_observations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE data_sources, imports, source_accounts, source_transactions, source_transaction_observations TO moneo_app;
--> statement-breakpoint
CREATE POLICY data_sources_isolation ON data_sources FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY imports_isolation ON imports FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY source_accounts_isolation ON source_accounts FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY source_transactions_isolation ON source_transactions FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY source_transaction_observations_isolation ON source_transaction_observations FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
