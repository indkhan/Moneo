-- Epoch 4, Issue 4.10 — balance inclusion cutoff.
--
-- A snapshot is only projectable when its inclusion semantics are explicit:
-- `cutoff_date` is the FIRST date NOT included in the snapshot (the
-- snapshot covers every transaction with effective_date < cutoff_date).
-- Roll-forward applies transactions on/after the cutoff exactly once.
-- NULL means unknown inclusion: the balance is usable as a point-in-time
-- fact but reconciliation stays unresolved (never guessed). Existing rows
-- predate cutoffs, so they read NULL and behave as before.
ALTER TABLE account_balance_snapshots ADD COLUMN cutoff_date date;
--> statement-breakpoint
CREATE INDEX account_balance_snapshots_account_cutoff_idx ON account_balance_snapshots USING btree (account_id, cutoff_date);
