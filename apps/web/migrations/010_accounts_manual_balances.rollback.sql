-- E03-S01 rollback: drop the new tables and columns added by 010.
-- Only safe before any real financial history exists.
-- Forward-fix rather than destructive down-migration after facts exist.

-- Drop RLS policies first (tables must exist)
DROP POLICY IF EXISTS manual_transactions_isolation ON manual_transactions;
DROP POLICY IF EXISTS balance_audit_isolation ON balance_audit;
DROP POLICY IF EXISTS balance_snapshots_isolation ON balance_snapshots;

-- Drop tables (order respects FKs)
DROP TABLE IF EXISTS manual_transactions;
DROP TABLE IF EXISTS balance_audit;
DROP TABLE IF EXISTS balance_snapshots;

-- Remove columns from accounts (data loss: only before real history)
ALTER TABLE accounts
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS archived,
  DROP COLUMN IF EXISTS currency;