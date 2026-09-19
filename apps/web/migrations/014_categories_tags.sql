-- E03-S05: categories, tags, transaction_tags, transaction version, category_id on transactions.
-- Composite tenant keys, FORCE RLS, exact BIGINT minor units.

-- System categories: global stable taxonomy (seeded, not user-editable)
CREATE TABLE IF NOT EXISTS system_categories (
  id UUID NOT NULL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  parent_id UUID NULL REFERENCES system_categories (id),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workspace categories: custom taxonomy per workspace
CREATE TABLE IF NOT EXISTS categories (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  parent_id UUID NULL,
  name TEXT NOT NULL CONSTRAINT categories_name_len CHECK (char_length(name) BETWEEN 1 AND 100),
  system_category_id UUID NULL REFERENCES system_categories (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES categories (workspace_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS categories_parent_idx ON categories (workspace_id, parent_id);

-- Tags: workspace-owned, normalized unique names
CREATE TABLE IF NOT EXISTS tags (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  name TEXT NOT NULL CONSTRAINT tags_name_len CHECK (char_length(name) BETWEEN 1 AND 100),
  normalized_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_normalized_unique ON tags (workspace_id, normalized_name) WHERE archived_at IS NULL;

-- Transaction tags: many-to-many
CREATE TABLE IF NOT EXISTS transaction_tags (
  workspace_id UUID NOT NULL,
  transaction_id UUID NOT NULL,
  tag_id UUID NOT NULL,
  PRIMARY KEY (workspace_id, transaction_id, tag_id),
  FOREIGN KEY (workspace_id, transaction_id) REFERENCES transactions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, tag_id) REFERENCES tags (workspace_id, id) ON DELETE CASCADE
);

-- Add category_id to transactions (imported)
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS category_id UUID NULL,
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_category_fk
  FOREIGN KEY (workspace_id, category_id) REFERENCES categories (workspace_id, id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions (workspace_id, category_id, effective_date DESC) WHERE category_id IS NOT NULL;

-- Add category_id and version to manual_transactions
ALTER TABLE manual_transactions
  ADD COLUMN IF NOT EXISTS category_id UUID NULL,
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE manual_transactions
  ADD CONSTRAINT manual_transactions_category_fk
  FOREIGN KEY (workspace_id, category_id) REFERENCES categories (workspace_id, id) ON DELETE SET NULL;

-- RLS policies
ALTER TABLE system_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_categories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_categories_read ON system_categories;
CREATE POLICY system_categories_read ON system_categories
  USING (is_active);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS categories_isolation ON categories;
CREATE POLICY categories_isolation ON categories
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tags_isolation ON tags;
CREATE POLICY tags_isolation ON tags
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE transaction_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transaction_tags_isolation ON transaction_tags;
CREATE POLICY transaction_tags_isolation ON transaction_tags
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

-- transactions and manual_transactions RLS already exist from prior migrations; version/category_id covered.

-- Seed minimal system taxonomy (fixed UUIDs, idempotent). Workspace
-- categories may reference these via system_category_id; assignment to
-- transactions always uses workspace category ids (FK scope).
INSERT INTO system_categories (id, code, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'INCOME', 'Income'),
  ('00000000-0000-4000-8000-000000000002', 'FOOD', 'Food'),
  ('00000000-0000-4000-8000-000000000003', 'TRANSPORT', 'Transport'),
  ('00000000-0000-4000-8000-000000000004', 'HOUSING', 'Housing'),
  ('00000000-0000-4000-8000-000000000005', 'UTILITIES', 'Utilities'),
  ('00000000-0000-4000-8000-000000000006', 'ENTERTAINMENT', 'Entertainment'),
  ('00000000-0000-4000-8000-000000000007', 'HEALTHCARE', 'Healthcare'),
  ('00000000-0000-4000-8000-000000000008', 'EDUCATION', 'Education'),
  ('00000000-0000-4000-8000-000000000009', 'TRANSFER', 'Transfer'),
  ('00000000-0000-4000-8000-000000000010', 'FEES', 'Fees'),
  ('00000000-0000-4000-8000-000000000011', 'OTHER', 'Other')
ON CONFLICT (id) DO NOTHING;