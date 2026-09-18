-- E02-S05: commit imports with multiplicity-safe duplicate review.
-- Canonical transactions, source links, review decisions and the imports.commit
-- job type. Composite tenant keys, FORCE RLS, exact BIGINT minor units.
-- Deterministic chunk commit with stable (import,row) source keys.
-- Rollback drops these empty tables only; forbidden after real import history.

-- Currency codes used by this slice (E03-S03 seeds the full reference table).
-- Here we only assert 3-char ISO codes on write; no FK yet.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_currency_fmt') THEN
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS base_currency_code CHAR(3) NOT NULL DEFAULT 'EUR';
    ALTER TABLE accounts ADD CONSTRAINT accounts_currency_fmt CHECK (base_currency_code ~ '^[A-Z]{3}$');
  END IF;
END $$;

-- Canonical transactions: one row per accepted observation (STAGED).
-- Exact money: amount_minor BIGINT (currency exponent handled at read/format).
-- Direction is explicit INFLOW/OUTFLOW; no signed amounts in storage.
-- source_link_id is nullable until resolution links to an existing tx.
-- composite FK to accounts (workspace_id, account_id).
CREATE TABLE IF NOT EXISTS transactions (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  account_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL CONSTRAINT transactions_amount_pos CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CONSTRAINT transactions_currency_fmt CHECK (currency ~ '^[A-Z]{3}$'),
  direction TEXT NOT NULL CONSTRAINT transactions_dir CHECK (direction IN ('INFLOW', 'OUTFLOW')),
  effective_date DATE NOT NULL,
  description TEXT NOT NULL CONSTRAINT transactions_desc_len CHECK (char_length(description) BETWEEN 1 AND 500),
  source_link_id UUID NULL,
  -- Provenance: original import + row + observation id for exact traceability
  import_id UUID NOT NULL,
  import_row_no INTEGER NOT NULL,
  observation_id TEXT NOT NULL CONSTRAINT transactions_oid_len CHECK (char_length(observation_id) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  -- Idempotency per (import,row): same-file retry or chunk replay converges
  UNIQUE (workspace_id, import_id, import_row_no)
);
CREATE INDEX IF NOT EXISTS transactions_account_idx ON transactions (workspace_id, account_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS transactions_import_idx ON transactions (workspace_id, import_id, import_row_no);

-- Source links: append-only provenance from staged observation to canonical tx
-- or to an existing tx (for match/keep-distinct resolutions). Never updated
-- after creation; review decisions are a separate table.
CREATE TABLE IF NOT EXISTS source_links (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  import_id UUID NOT NULL,
  import_row_no INTEGER NOT NULL,
  observation_id TEXT NOT NULL CONSTRAINT source_links_oid_len CHECK (char_length(observation_id) BETWEEN 1 AND 64),
  target_transaction_id UUID NULL,
  status TEXT NOT NULL CONSTRAINT source_links_status CHECK (status IN ('NEW', 'MATCHED', 'PENDING_REVIEW', 'REJECTED', 'KEPT_DISTINCT')),
  match_reason TEXT NULL,
  resolved_at TIMESTAMPTZ NULL,
  resolved_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, import_id) REFERENCES imports (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, target_transaction_id) REFERENCES transactions (workspace_id, id) ON DELETE SET NULL,
  -- One source link per observation
  UNIQUE (workspace_id, import_id, import_row_no)
);
CREATE INDEX IF NOT EXISTS source_links_status_idx ON source_links (workspace_id, import_id, status, import_row_no);

-- Review decisions: explicit human/automated resolution of PENDING_REVIEW
-- source links. Append-only audit trail; the latest decision wins via
-- resolved_at ordering (UI presents actions, not history replay).
CREATE TABLE IF NOT EXISTS review_decisions (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  source_link_id UUID NOT NULL,
  decision TEXT NOT NULL CONSTRAINT review_decisions_decision CHECK (decision IN ('LINK_EXISTING', 'KEEP_DISTINCT', 'REJECT')),
  target_transaction_id UUID NULL,
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, source_link_id) REFERENCES source_links (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, target_transaction_id) REFERENCES transactions (workspace_id, id) ON DELETE SET NULL
);

-- Import commit batches: tracks a fan-in completion after all files in a
-- batch reach terminal/review states. One row per batch idempotency key.
-- Completion emits once via outbox; counts reconciled from stored rows.
CREATE TABLE IF NOT EXISTS import_commit_batches (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CONSTRAINT import_commit_batches_key_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  status TEXT NOT NULL CONSTRAINT import_commit_batches_status CHECK (status IN ('PENDING', 'COMMITTING', 'COMPLETED', 'FAILED')),
  total_files INTEGER NOT NULL DEFAULT 0,
  completed_files INTEGER NOT NULL DEFAULT 0,
  total_rows INTEGER NOT NULL DEFAULT 0,
  total_staged INTEGER NOT NULL DEFAULT 0,
  total_matched INTEGER NOT NULL DEFAULT 0,
  total_review INTEGER NOT NULL DEFAULT 0,
  total_rejected INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key)
);

-- Import commit job input/output refs
ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start', 'imports.parse', 'imports.commit'));
ALTER TABLE background_job_results DROP CONSTRAINT IF EXISTS background_job_results_kind;
ALTER TABLE background_job_results ADD CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop', 'import-parsed', 'import-committed'));

-- RLS policies: strict workspace equality
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transactions_isolation ON transactions;
CREATE POLICY transactions_isolation ON transactions
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE source_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS source_links_isolation ON source_links;
CREATE POLICY source_links_isolation ON source_links
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_decisions_isolation ON review_decisions;
CREATE POLICY review_decisions_isolation ON review_decisions
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE import_commit_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_commit_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_commit_batches_isolation ON import_commit_batches;
CREATE POLICY import_commit_batches_isolation ON import_commit_batches
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);