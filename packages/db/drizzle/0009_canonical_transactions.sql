-- Epoch 4, Issue 4.2 — canonical transaction model.
--
-- Accepted user-facing financial understanding, derived from source
-- observations (Epoch 3) WITHOUT deleting them. Money stays exact: amounts
-- are non-negative integer minor units plus an explicit direction; the sign
-- never lives on the amount (Issue 0.9 rule).
--
-- Direction uses `credit`/`debit`, consistent with the shared money utils and
-- the statement mapping layer — not the architecture text's INFLOW/OUTFLOW
-- sketch. `counterparty_id` / `category_id` are nullable UUIDs with NO foreign
-- key yet: Epoch 5 (Issues 5.1/5.3) owns counterparties, categories, and tags
-- and will add the references then.
--
-- Deletion semantics: `account_id` has NO cascade — deleting an account that
-- still owns history fails loudly, so archiving (Issue 4.1 `archived_at`)
-- stays the only ordinary path and history is never cascade-erased.
-- Workspace removal still wipes the tenant chain.
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id),
  status text NOT NULL DEFAULT 'POSTED',
  direction text NOT NULL,
  amount_minor bigint NOT NULL,
  currency_code text NOT NULL,
  effective_date date NOT NULL,
  authorized_at timestamp with time zone,
  posted_at timestamp with time zone,
  counterparty_id uuid,
  category_id uuid,
  description text NOT NULL,
  note text,
  excluded_from_analytics boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  archived_at timestamp with time zone,
  CONSTRAINT transactions_amount_check CHECK (amount_minor > 0),
  CONSTRAINT transactions_direction_check CHECK (direction in ('credit', 'debit')),
  CONSTRAINT transactions_status_check CHECK (status in ('PENDING', 'POSTED', 'VOIDED'))
);
--> statement-breakpoint
CREATE TABLE transaction_source_links (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  source_transaction_id uuid NOT NULL REFERENCES source_transactions (id) ON DELETE CASCADE,
  relationship text NOT NULL DEFAULT 'PRIMARY',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT transaction_source_links_pk PRIMARY KEY (transaction_id, source_transaction_id),
  CONSTRAINT transaction_source_links_relationship_check CHECK (relationship in ('PRIMARY', 'PENDING_PREDECESSOR', 'MERGED', 'OTHER'))
);
--> statement-breakpoint
CREATE INDEX transactions_workspace_date_idx ON transactions USING btree (workspace_id, effective_date DESC);
--> statement-breakpoint
CREATE INDEX transactions_account_date_idx ON transactions USING btree (account_id, effective_date DESC);
--> statement-breakpoint
CREATE INDEX transaction_source_links_source_idx ON transaction_source_links USING btree (source_transaction_id);
--> statement-breakpoint
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transaction_source_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE transactions, transaction_source_links TO moneo_app;
--> statement-breakpoint
CREATE POLICY transactions_isolation ON transactions FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY transaction_source_links_isolation ON transaction_source_links FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
