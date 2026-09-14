-- Epoch 5, Issue 5.7: a frozen selection must retain the row versions it saw.
ALTER TABLE frozen_transaction_selections
  ADD COLUMN transaction_versions jsonb NOT NULL DEFAULT '[]'::jsonb;
