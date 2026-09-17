-- E00-S04 durable-effects proof schema (synthetic, disposable).
--
-- Lives in the dedicated proof database only (default: moneo_durable_proof).
-- Every row is tenant-scoped; the suite runs a second synthetic tenant to
-- detect unscoped state changes. gen_random_uuid() is built into PG 13+.
-- No money columns here: the effect is a synthetic unit counter increment,
-- so exactly-once is asserted as counter value == distinct operations.

CREATE TABLE IF NOT EXISTS proof_commands (
  operation_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACCEPTED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT proof_commands_status CHECK (status IN ('ACCEPTED', 'CANCELLED'))
);

CREATE TABLE IF NOT EXISTS proof_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL UNIQUE REFERENCES proof_commands (operation_id),
  tenant_id TEXT NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proof_jobs (
  operation_id UUID PRIMARY KEY REFERENCES proof_commands (operation_id),
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'QUEUED',
  attempt_generation BIGINT NOT NULL DEFAULT 0,
  claimed_attempt_id UUID NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  cancel_requested_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT proof_jobs_state CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'CANCELLED'))
);

CREATE TABLE IF NOT EXISTS proof_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES proof_commands (operation_id),
  tenant_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  generation BIGINT NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  UNIQUE (operation_id, attempt_no),
  CONSTRAINT proof_attempts_status CHECK (status IN ('RUNNING', 'SUCCEEDED', 'STALE', 'BLOCKED'))
);

CREATE TABLE IF NOT EXISTS proof_counters (
  tenant_id TEXT NOT NULL,
  counter_id TEXT NOT NULL,
  value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, counter_id)
);

CREATE TABLE IF NOT EXISTS proof_provider_results (
  operation_id UUID PRIMARY KEY REFERENCES proof_commands (operation_id),
  tenant_id TEXT NOT NULL,
  response JSONB NOT NULL,
  received_generation BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proof_effects (
  operation_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  counter_id TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
