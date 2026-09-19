-- E04-S05: trusted host confirmation for AI-proposed financial actions
-- (product §15; architecture command/consent/security contracts; existing
-- transactions.createManual idempotency/audit/undo). A proposal is created by
-- the AI, stored with a hash of the payload, and confirmed by the host
-- through the existing command path. The proposal expires and is single-use.
-- Composite keys per §27; FORCE RLS per §23.

CREATE TABLE IF NOT EXISTS ai_action_proposals (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  -- The action kind; only "create_manual_transaction" for R1.
  kind TEXT NOT NULL CONSTRAINT ai_action_proposals_kind CHECK (kind IN ('create_manual_transaction')),
  -- Opaque payload hash (SHA-256 of canonical JSON) for integrity verification.
  payload_hash TEXT NOT NULL CONSTRAINT ai_action_proposals_hash_len CHECK (char_length(payload_hash) = 64),
  -- The proposed payload (validated but not executed until confirmation).
  -- Contains: accountId, amountMinor, currency, direction, effectiveDate, description.
  payload JSONB NOT NULL,
  -- Version of the account at proposal time (for optimistic concurrency).
  account_version BIGINT NOT NULL,
  policy_version BIGINT NOT NULL CONSTRAINT ai_action_proposals_policy_version_min CHECK (policy_version >= 1),
  -- Actor who proposed the action (the AI run / user session).
  proposed_by UUID NOT NULL REFERENCES users (id),
  -- Status: proposed -> confirmed | expired | cancelled.
  status TEXT NOT NULL DEFAULT 'proposed' CONSTRAINT ai_action_proposals_status CHECK (status IN ('proposed', 'confirmed', 'expired', 'cancelled')),
  -- Confirmation actor (human who clicked confirm).
  confirmed_by UUID NULL REFERENCES users (id),
  -- Idempotency key for the confirmation command.
  idempotency_key TEXT NULL CONSTRAINT ai_action_proposals_key_len CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),
  -- The command operation ID if confirmed (for audit trail).
  command_operation_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT ai_action_proposals_payload_keys CHECK (
    payload ? 'accountId' AND
    payload ? 'amountMinor' AND
    payload ? 'currency' AND
    payload ? 'direction' AND
    payload ? 'effectiveDate' AND
    payload ? 'description'
  )
);

CREATE INDEX IF NOT EXISTS ai_action_proposals_status_idx ON ai_action_proposals (workspace_id, status, expires_at);

ALTER TABLE ai_action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_action_proposals_isolation ON ai_action_proposals;
CREATE POLICY ai_action_proposals_isolation ON ai_action_proposals
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
