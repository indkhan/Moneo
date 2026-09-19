-- E04-S01: atomic provider-dispatch budgets and usage ledger (product §§4,
-- 29-30; architecture §§124-138, 175-190, 416-489; existing ai_policies,
-- exclusions, permits and durable jobs). A dispatch is admitted only after
-- tenant policy, route, concurrency and money/token budgets are reserved in
-- ONE transaction; completion reconciles measured usage, holds unknown usage
-- as PENDING (never zero), and releases only documented terminal classes.
-- Composite keys per §27; FORCE RLS per §23. Rollback drops these empty
-- pre-E04 tables only; forbidden once real dispatch history exists.

-- Per-workspace budgets. Defaults are the synthetic test baseline (€10.00
-- money, 40k tokens, 5 concurrent); production values arrive with the
-- story that qualifies the production route.
CREATE TABLE IF NOT EXISTS ai_dispatch_budgets (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  money_budget_minor BIGINT NOT NULL DEFAULT 1000 CONSTRAINT ai_budgets_money_min CHECK (money_budget_minor >= 0),
  token_budget INTEGER NOT NULL DEFAULT 40000 CONSTRAINT ai_budgets_tokens_min CHECK (token_budget >= 0),
  concurrency_limit INTEGER NOT NULL DEFAULT 5 CONSTRAINT ai_budgets_concurrency_range CHECK (concurrency_limit BETWEEN 1 AND 32),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per idempotent dispatch request. The (workspace, idempotency_key)
-- unique claim makes replay converge; the request_hash distinguishes a
-- genuine replay (same bytes) from conflicting reuse (different bytes).
CREATE TABLE IF NOT EXISTS ai_dispatch_reservations (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CONSTRAINT ai_reservations_key_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  permit_id UUID NULL,
  policy_version BIGINT NOT NULL CONSTRAINT ai_reservations_version_min CHECK (policy_version >= 1),
  route TEXT NOT NULL CONSTRAINT ai_reservations_route CHECK (route IN ('development', 'production')),
  purpose TEXT NOT NULL CONSTRAINT ai_reservations_purpose_len CHECK (char_length(purpose) BETWEEN 1 AND 120),
  status TEXT NOT NULL CONSTRAINT ai_reservations_status CHECK (status IN ('RESERVED', 'RECONCILED', 'PENDING', 'RELEASED', 'CANCELLED')),
  reserved_cost_minor BIGINT NOT NULL CONSTRAINT ai_reservations_cost_min CHECK (reserved_cost_minor >= 0),
  input_estimate INTEGER NOT NULL CONSTRAINT ai_reservations_in_min CHECK (input_estimate >= 0),
  output_ceiling INTEGER NOT NULL CONSTRAINT ai_reservations_out_range CHECK (output_ceiling BETWEEN 1 AND 4000),
  request_hash TEXT NOT NULL CONSTRAINT ai_reservations_hash_len CHECK (char_length(request_hash) = 64),
  attempt SMALLINT NOT NULL DEFAULT 1 CONSTRAINT ai_reservations_attempt_range CHECK (attempt BETWEEN 1 AND 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ai_reservations_active_idx ON ai_dispatch_reservations (workspace_id, status, expires_at);

-- Immutable usage ledger: exactly one row per reservation once the provider
-- interaction settles. Unknown cost stays NULL with status PENDING — it is
-- held against budgets at the full reserved amount, never coerced to zero.
CREATE TABLE IF NOT EXISTS ai_dispatch_usage (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  status TEXT NOT NULL CONSTRAINT ai_usage_status CHECK (status IN ('RECONCILED', 'PENDING', 'RELEASED')),
  input_tokens INTEGER NULL CONSTRAINT ai_usage_in_min CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER NULL CONSTRAINT ai_usage_out_min CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reconciled_cost_minor BIGINT NULL CONSTRAINT ai_usage_cost_min CHECK (reconciled_cost_minor IS NULL OR reconciled_cost_minor >= 0),
  error_class TEXT NULL CONSTRAINT ai_usage_error_len CHECK (error_class IS NULL OR char_length(error_class) BETWEEN 1 AND 60),
  model TEXT NOT NULL CONSTRAINT ai_usage_model_len CHECK (char_length(model) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, reservation_id),
  FOREIGN KEY (workspace_id, reservation_id) REFERENCES ai_dispatch_reservations (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE ai_dispatch_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_dispatch_budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_budgets_isolation ON ai_dispatch_budgets;
CREATE POLICY ai_budgets_isolation ON ai_dispatch_budgets
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE ai_dispatch_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_dispatch_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_reservations_isolation ON ai_dispatch_reservations;
CREATE POLICY ai_reservations_isolation ON ai_dispatch_reservations
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE ai_dispatch_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_dispatch_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_usage_isolation ON ai_dispatch_usage;
CREATE POLICY ai_usage_isolation ON ai_dispatch_usage
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
