-- E03-S01: manage accounts, manual transactions and dated balances.
-- Extend accounts with version/archived/source metadata (currency already exists as base_currency_code from 009).
-- Add tenant-keyed dated balance snapshots and audit rows.
-- Composite tenant keys, FORCE RLS, exact BIGINT minor units.
-- Signed balances (can be negative for overdraft); positive amount_minor + direction for transactions.
-- One account currency is immutable after financial facts exist (enforced by migration policy).

-- Ensure accounts.version exists (added in 003_commands) and add new columns
-- base_currency_code already exists from 009_import_commit with CHECK constraint
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD CONSTRAINT accounts_source_check CHECK (source IN ('manual', 'import'));

-- Backfill existing imported accounts: source='import' (currency already set via base_currency_code)
UPDATE accounts
SET source = 'import'
WHERE source = 'manual'
  AND workspace_id IN (SELECT id FROM workspaces);

-- Dated balance snapshots: one row per account at a specific as-of date.
-- Signed minor units (can be negative). Provenance, freshness, reconciliation state.
CREATE TABLE IF NOT EXISTS balance_snapshots (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  account_id UUID NOT NULL,
  as_of_date DATE NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL CONSTRAINT balance_snapshots_currency_fmt CHECK (currency ~ '^[A-Z]{3}$'),
  source TEXT NOT NULL DEFAULT 'manual' CONSTRAINT balance_snapshots_source CHECK (source IN ('manual', 'import', 'reconciliation')),
  provenance JSONB NOT NULL DEFAULT '{}',
  freshness TEXT NOT NULL DEFAULT 'current' CONSTRAINT balance_snapshots_freshness CHECK (freshness IN ('current', 'stale', 'unknown')),
  reconciliation_state TEXT NOT NULL DEFAULT 'unreconciled' CONSTRAINT balance_snapshots_recon CHECK (reconciliation_state IN ('unreconciled', 'reconciled', 'disputed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  -- One snapshot per account per as-of date
  UNIQUE (workspace_id, account_id, as_of_date)
);
CREATE INDEX IF NOT EXISTS balance_snapshots_account_idx ON balance_snapshots (workspace_id, account_id, as_of_date DESC);

-- Balance audit: append-only log of corrections and corrections-of-corrections.
-- Never overwrites; references original snapshot and replacement snapshot.
CREATE TABLE IF NOT EXISTS balance_audit (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  account_id UUID NOT NULL,
  action TEXT NOT NULL CONSTRAINT balance_audit_action CHECK (action IN ('create', 'correct', 'reconcile', 'void')),
  prior_amount_minor BIGINT NULL,
  new_amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL CONSTRAINT balance_audit_currency_fmt CHECK (currency ~ '^[A-Z]{3}$'),
  reason TEXT NOT NULL CONSTRAINT balance_audit_reason_len CHECK (char_length(reason) BETWEEN 1 AND 500),
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES balance_snapshots (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS balance_audit_snapshot_idx ON balance_audit (workspace_id, snapshot_id, created_at);
CREATE INDEX IF NOT EXISTS balance_audit_account_idx ON balance_audit (workspace_id, account_id, created_at);

-- Manual transactions: separate from imported transactions table (009_import_commit).
-- Positive amount_minor + explicit direction; manual source/audit identity.
-- Links to balance snapshot if already included.
CREATE TABLE IF NOT EXISTS manual_transactions (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  account_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL CONSTRAINT manual_transactions_amount_pos CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CONSTRAINT manual_transactions_currency_fmt CHECK (currency ~ '^[A-Z]{3}$'),
  direction TEXT NOT NULL CONSTRAINT manual_transactions_dir CHECK (direction IN ('INFLOW', 'OUTFLOW')),
  effective_date DATE NOT NULL,
  description TEXT NOT NULL CONSTRAINT manual_transactions_desc_len CHECK (char_length(description) BETWEEN 1 AND 500),
  balance_snapshot_id UUID NULL,
  -- Provenance: manual entry actor + optional reference
  actor_id UUID NOT NULL,
  reference TEXT NULL CONSTRAINT manual_transactions_ref_len CHECK (char_length(reference) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, balance_snapshot_id) REFERENCES balance_snapshots (workspace_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS manual_transactions_account_idx ON manual_transactions (workspace_id, account_id, effective_date DESC);

-- RLS policies: strict workspace equality
ALTER TABLE balance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS balance_snapshots_isolation ON balance_snapshots;
CREATE POLICY balance_snapshots_isolation ON balance_snapshots
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE balance_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS balance_audit_isolation ON balance_audit;
CREATE POLICY balance_audit_isolation ON balance_audit
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE manual_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS manual_transactions_isolation ON manual_transactions;
CREATE POLICY manual_transactions_isolation ON manual_transactions
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

-- accounts RLS already exists from 002; no change needed.
-- accounts version column already exists from 003.