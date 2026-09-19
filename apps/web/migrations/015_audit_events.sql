-- E03-S05: audit_events for immutable correction history.
-- Append-only; never updated/deleted in normal flows.
-- Composite tenant key, FORCE RLS.

CREATE TABLE IF NOT EXISTS audit_events (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  actor_type TEXT NOT NULL CONSTRAINT audit_events_actor_type CHECK (actor_type IN ('user', 'system', 'ai')),
  actor_user_id UUID NULL,
  ai_run_id UUID NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  before_state JSONB NULL,
  after_state JSONB NULL,
  reason TEXT NULL CONSTRAINT audit_events_reason_len CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  operation_id UUID NULL,
  compensating_operation_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (workspace_id, entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS audit_events_operation_idx ON audit_events (workspace_id, operation_id);
CREATE INDEX IF NOT EXISTS audit_events_compensating_idx ON audit_events (workspace_id, compensating_operation_id);

-- RLS policies
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_events_isolation ON audit_events;
CREATE POLICY audit_events_isolation ON audit_events
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);