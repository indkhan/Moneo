-- E04-S03: scoped tool-call record for grounded generation (product §§2.3,
-- 23; architecture §§124-174, 416-489, 535-538; E03 calculation evidence).
-- One append-only row per executed tool call: which allowlisted tool ran,
-- with what hashed arguments, how large the bounded result was, which
-- immutable evidence it cited, and whether it succeeded. Arguments and
-- results containing finance data are never stored here — only the SHA-256
-- of the canonical argument bytes plus sizes/counts/evidence IDs, so the
-- ledger stays joinable for S04 evidence navigation without becoming a
-- second finance store. Composite keys per §27; FORCE RLS per §23. Rollback
-- drops this pre-E04 table only; forbidden once real tool history exists.

CREATE TABLE IF NOT EXISTS chat_tool_calls (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  step INTEGER NOT NULL CONSTRAINT chat_tool_calls_step_min CHECK (step >= 1),
  tool_name TEXT NOT NULL CONSTRAINT chat_tool_calls_name_len CHECK (char_length(tool_name) BETWEEN 1 AND 120),
  args_hash TEXT NOT NULL CONSTRAINT chat_tool_calls_hash_len CHECK (char_length(args_hash) = 64),
  result_bytes INTEGER NOT NULL CONSTRAINT chat_tool_calls_bytes_min CHECK (result_bytes >= 0),
  result_rows INTEGER NOT NULL CONSTRAINT chat_tool_calls_rows_min CHECK (result_rows >= 0),
  evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb CONSTRAINT chat_tool_calls_evidence_array CHECK (jsonb_typeof(evidence_ids) = 'array'),
  status TEXT NOT NULL CONSTRAINT chat_tool_calls_status CHECK (status IN ('ok', 'error')),
  error_code TEXT NULL CONSTRAINT chat_tool_calls_error_len CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES chat_attempts (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chat_tool_calls_attempt_idx ON chat_tool_calls (workspace_id, attempt_id, step);

ALTER TABLE chat_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_tool_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_tool_calls_isolation ON chat_tool_calls;
CREATE POLICY chat_tool_calls_isolation ON chat_tool_calls
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
