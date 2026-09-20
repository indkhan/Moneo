-- E06-S02: goals and virtual fixed-amount allocations.
-- Goals are first-class rows with target/date/priority; allocations
-- reserve spendable cash per (goal,account) without creating cash.
-- Composite tenant keys, FORCE RLS, single-tx over-allocation check.

CREATE TABLE IF NOT EXISTS goals (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  name TEXT NOT NULL CONSTRAINT goals_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
  goal_type TEXT NOT NULL CONSTRAINT goals_type CHECK (goal_type IN ('SAVINGS_TARGET', 'EMERGENCY_FUND', 'PURCHASE', 'TRAVEL', 'DEBT_REDUCTION', 'CUSTOM')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CONSTRAINT goals_status CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  target_amount_minor BIGINT NULL CONSTRAINT goals_target_pos CHECK (target_amount_minor IS NULL OR target_amount_minor > 0),
  currency_code CHAR(3) NULL CONSTRAINT goals_currency_fmt CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  target_date DATE NULL,
  priority SMALLINT NULL CONSTRAINT goals_priority CHECK (priority IS NULL OR (priority BETWEEN 1 AND 5)),
  notes TEXT NULL CONSTRAINT goals_notes_len CHECK (char_length(notes) <= 500),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS goals_status_idx ON goals (workspace_id, status);

CREATE TABLE IF NOT EXISTS goal_allocations (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  goal_id UUID NOT NULL,
  account_id UUID NOT NULL,
  allocation_type TEXT NOT NULL DEFAULT 'FIXED_AMOUNT' CONSTRAINT goal_allocations_type CHECK (allocation_type = 'FIXED_AMOUNT'),
  amount_minor BIGINT NOT NULL CONSTRAINT goal_allocations_amount_pos CHECK (amount_minor > 0),
  currency_code CHAR(3) NOT NULL CONSTRAINT goal_allocations_currency_fmt CHECK (currency_code ~ '^[A-Z]{3}$'),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, goal_id) REFERENCES goals (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, goal_id, account_id)
);
CREATE INDEX IF NOT EXISTS goal_allocations_goal_idx ON goal_allocations (workspace_id, goal_id);
CREATE INDEX IF NOT EXISTS goal_allocations_account_idx ON goal_allocations (workspace_id, account_id);

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goals_isolation ON goals;
CREATE POLICY goals_isolation ON goals
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE goal_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goal_allocations_isolation ON goal_allocations;
CREATE POLICY goal_allocations_isolation ON goal_allocations
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);