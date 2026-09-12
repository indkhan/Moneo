-- Epoch 5, Issue 5.2 — optimistic entity versions.
--
-- Mutable canonical objects get a `version` counter so concurrent editors
-- cannot silently overwrite each other: every correction command
-- (Issue 5.3) reads the row, compares the caller's `expectedVersion`, and
-- increments on success. A stale tab therefore fails with VERSION_CONFLICT
-- instead of clobbering the newer change (Epoch 5 acceptance). Existing
-- rows predate versioning and start at 1; every new row defaults to 1.
ALTER TABLE transactions ADD COLUMN version bigint NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE accounts ADD COLUMN version bigint NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE categories ADD COLUMN version bigint NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE counterparties ADD COLUMN version bigint NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE transactions ADD CONSTRAINT transactions_version_check CHECK (version >= 1);
--> statement-breakpoint
ALTER TABLE accounts ADD CONSTRAINT accounts_version_check CHECK (version >= 1);
--> statement-breakpoint
ALTER TABLE categories ADD CONSTRAINT categories_version_check CHECK (version >= 1);
--> statement-breakpoint
ALTER TABLE counterparties ADD CONSTRAINT counterparties_version_check CHECK (version >= 1);
