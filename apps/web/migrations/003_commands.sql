-- E01-S04: exact command contracts. Optimistic versions on accounts (§63)
-- and the idempotent command_operations journal (§§60–61). Composite keys
-- per §27; FORCE RLS per §23. Replay detail retention 30 days (§60); an
-- expired key returns an explicit expired result, never a silent new command.
-- Deliberate §61 sketch deviations pre-E02: the claim row starts FAILED_FINAL
-- and is upgraded to SUCCEEDED (no IN_PROGRESS state while execution is
-- single-transaction atomic); completed_at is NOT NULL DEFAULT now();
-- actor_type/ai_run_id arrive with AI/worker callers.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_version_min') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_version_min CHECK (version >= 1);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS command_operations (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  command_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CONSTRAINT command_operations_key_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL,
  actor_id UUID NULL,
  status TEXT NOT NULL CONSTRAINT command_operations_status CHECK (status IN ('SUCCEEDED', 'FAILED_FINAL')),
  response_payload JSONB NULL,
  error_payload JSONB NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, command_name, idempotency_key)
);

ALTER TABLE command_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS command_operations_isolation ON command_operations;
CREATE POLICY command_operations_isolation ON command_operations
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
