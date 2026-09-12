-- Epoch 5, Issue 5.1 — categorization schema.
--
-- User corrections (Issues 5.3/5.4) need first-class targets: workspace
-- categories (optionally rooted in a global system taxonomy), merchant
-- counterparties, free-form tags, and transaction relations (reserved for
-- transfer linking in Epoch 8; Epoch 5 only needs RELATED notes between
-- canonical rows). Raw source observations are never rewritten — a
-- correction only re-points the canonical row and appends audit history.
--
-- Tenancy follows the Epoch 1/3/4 pattern: every table except the global
-- `system_categories` carries `workspace_id`, the app role never bypasses
-- RLS, and every query runs inside `withWorkspaceTransaction`.
-- Uniqueness is per-workspace only: two workspaces may each own a
-- "Groceries" category or "lidl" counterparty without colliding.
-- `system_categories` is global reference data like `currencies`: no RLS,
-- readable by the app role, writable by the migration/owner role only.
CREATE TABLE system_categories (
  code text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'expense',
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT system_categories_kind_check CHECK (kind in ('expense', 'income', 'transfer'))
);
--> statement-breakpoint
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'expense',
  system_category_code text REFERENCES system_categories (code) ON DELETE SET NULL,
  archived_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT categories_workspace_name_uniq UNIQUE (workspace_id, name),
  CONSTRAINT categories_kind_check CHECK (kind in ('expense', 'income', 'transfer'))
);
--> statement-breakpoint
CREATE TABLE counterparties (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  normalized_name text NOT NULL,
  display_name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT counterparties_workspace_normalized_uniq UNIQUE (workspace_id, normalized_name)
);
--> statement-breakpoint
CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT tags_workspace_name_uniq UNIQUE (workspace_id, name)
);
--> statement-breakpoint
CREATE TABLE transaction_tags (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT transaction_tags_pk PRIMARY KEY (transaction_id, tag_id)
);
--> statement-breakpoint
CREATE TABLE transaction_relations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  from_transaction_id uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  to_transaction_id uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  relation_type text NOT NULL DEFAULT 'RELATED',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT transaction_relations_pair_type_uniq UNIQUE (from_transaction_id, to_transaction_id, relation_type),
  CONSTRAINT transaction_relations_type_check CHECK (relation_type in ('TRANSFER', 'RELATED', 'DUPLICATE')),
  CONSTRAINT transaction_relations_no_self_check CHECK (from_transaction_id <> to_transaction_id)
);
--> statement-breakpoint
CREATE INDEX categories_workspace_created_idx ON categories USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX counterparties_workspace_created_idx ON counterparties USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX tags_workspace_created_idx ON tags USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX transaction_tags_tag_idx ON transaction_tags USING btree (tag_id);
--> statement-breakpoint
CREATE INDEX transaction_tags_transaction_idx ON transaction_tags USING btree (transaction_id);
--> statement-breakpoint
CREATE INDEX transaction_relations_from_idx ON transaction_relations USING btree (from_transaction_id);
--> statement-breakpoint
CREATE INDEX transaction_relations_to_idx ON transaction_relations USING btree (to_transaction_id);
--> statement-breakpoint
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE counterparties ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transaction_tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transaction_relations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON TABLE system_categories TO moneo_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE categories, counterparties, tags, transaction_tags, transaction_relations TO moneo_app;
--> statement-breakpoint
CREATE POLICY categories_isolation ON categories FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY counterparties_isolation ON counterparties FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tags_isolation ON tags FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY transaction_tags_isolation ON transaction_tags FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY transaction_relations_isolation ON transaction_relations FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
