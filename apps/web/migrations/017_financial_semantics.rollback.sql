ALTER TABLE manual_transactions DROP CONSTRAINT IF EXISTS manual_transactions_link_required;
ALTER TABLE manual_transactions DROP CONSTRAINT IF EXISTS manual_transactions_linked_account_fk;
ALTER TABLE manual_transactions DROP COLUMN IF EXISTS linked_account_id;
ALTER TABLE manual_transactions DROP COLUMN IF EXISTS financial_kind;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_link_required;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_linked_account_fk;
ALTER TABLE transactions DROP COLUMN IF EXISTS linked_account_id;
ALTER TABLE transactions DROP COLUMN IF EXISTS financial_kind;
