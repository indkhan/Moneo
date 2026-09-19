-- E03 audit remediation: persist user-confirmed financial semantics consumed by
-- the authoritative calculation boundary. Defaults preserve existing rows.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS financial_kind TEXT NOT NULL DEFAULT 'NORMAL'
    CONSTRAINT transactions_financial_kind_check CHECK (financial_kind IN ('NORMAL', 'TRANSFER', 'FEE', 'REFUND', 'CREDIT_REPAYMENT')),
  ADD COLUMN IF NOT EXISTS linked_account_id UUID NULL,
  ADD CONSTRAINT transactions_linked_account_fk FOREIGN KEY (workspace_id, linked_account_id) REFERENCES accounts (workspace_id, id) ON DELETE SET NULL;

ALTER TABLE manual_transactions
  ADD COLUMN IF NOT EXISTS financial_kind TEXT NOT NULL DEFAULT 'NORMAL'
    CONSTRAINT manual_transactions_financial_kind_check CHECK (financial_kind IN ('NORMAL', 'TRANSFER', 'FEE', 'REFUND', 'CREDIT_REPAYMENT')),
  ADD COLUMN IF NOT EXISTS linked_account_id UUID NULL,
  ADD CONSTRAINT manual_transactions_linked_account_fk FOREIGN KEY (workspace_id, linked_account_id) REFERENCES accounts (workspace_id, id) ON DELETE SET NULL;

ALTER TABLE transactions ADD CONSTRAINT transactions_link_required CHECK (financial_kind NOT IN ('TRANSFER', 'CREDIT_REPAYMENT') OR linked_account_id IS NOT NULL);
ALTER TABLE manual_transactions ADD CONSTRAINT manual_transactions_link_required CHECK (financial_kind NOT IN ('TRANSFER', 'CREDIT_REPAYMENT') OR linked_account_id IS NOT NULL);
