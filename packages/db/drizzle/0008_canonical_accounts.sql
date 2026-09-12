-- Epoch 4, Issue 4.1 — canonical account model.
--
-- Canonical user-facing accounts derive from source observations (Epoch 3)
-- WITHOUT deleting them. Tenancy follows the Epoch 1/3 pattern: every table
-- carries `workspace_id`, the app role never bypasses RLS, and every query
-- runs inside `withWorkspaceTransaction`.
--
-- Deletion semantics: ordinary product use archives accounts (`archived_at`),
-- never hard-deletes them. The CASCADEs below only bound the blast radius
-- when a whole workspace is removed (tenant chain) or when derived/link rows
-- lose their parent: links and snapshots are rebuildable projections, so
-- they follow their account; canonical transactions (Issue 4.2) reference
-- accounts with RESTRICT so history can never be cascade-erased by mistake.
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL,
  institution_name text,
  account_type text NOT NULL DEFAULT 'OTHER',
  currency_code text NOT NULL DEFAULT 'EUR',
  is_spendable boolean NOT NULL DEFAULT true,
  include_in_net_worth boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  archived_at timestamp with time zone,
  CONSTRAINT accounts_type_check CHECK (account_type in ('CHECKING', 'SAVINGS', 'CASH', 'CREDIT', 'INVESTMENT', 'WALLET', 'OTHER'))
);
--> statement-breakpoint
CREATE TABLE account_source_links (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES source_accounts (id) ON DELETE CASCADE,
  relationship text NOT NULL DEFAULT 'PRIMARY',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT account_source_links_pk PRIMARY KEY (account_id, source_account_id),
  CONSTRAINT account_source_links_relationship_check CHECK (relationship in ('PRIMARY', 'MERGED', 'OTHER'))
);
--> statement-breakpoint
CREATE TABLE account_balance_snapshots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  observed_at timestamp with time zone NOT NULL DEFAULT now(),
  current_amount_minor bigint,
  available_amount_minor bigint,
  credit_limit_minor bigint,
  currency_code text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  source_import_id uuid REFERENCES imports (id) ON DELETE SET NULL,
  freshness text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT account_balance_snapshots_source_check CHECK (source in ('statement', 'manual', 'imported', 'other'))
);
--> statement-breakpoint
CREATE INDEX accounts_workspace_created_idx ON accounts USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX account_source_links_source_idx ON account_source_links USING btree (source_account_id);
--> statement-breakpoint
CREATE INDEX account_balance_snapshots_account_observed_idx ON account_balance_snapshots USING btree (account_id, observed_at DESC);
--> statement-breakpoint
CREATE INDEX account_balance_snapshots_workspace_created_idx ON account_balance_snapshots USING btree (workspace_id, created_at);
--> statement-breakpoint
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE account_source_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE account_balance_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE accounts, account_source_links, account_balance_snapshots TO moneo_app;
--> statement-breakpoint
CREATE POLICY accounts_isolation ON accounts FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY account_source_links_isolation ON account_source_links FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY account_balance_snapshots_isolation ON account_balance_snapshots FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
