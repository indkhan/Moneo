-- E03-S07: recurring confirmation overrides (no booked-row generation).
-- Detection is pure (src/recurring.ts, deterministic fingerprints); this
-- table stores only user confirm/dismiss overrides keyed by fingerprint.
-- Composite tenant key, FORCE RLS.

CREATE TABLE IF NOT EXISTS recurring_overrides (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Stable UUID for audit_events.entity_id (which is UUID-typed):
  -- fingerprints are 64-hex and cannot sit in that column.
  id UUID NOT NULL,
  fingerprint TEXT NOT NULL CONSTRAINT recurring_overrides_fp_len CHECK (char_length(fingerprint) = 64),
  status TEXT NOT NULL CONSTRAINT recurring_overrides_status CHECK (status IN ('proposed', 'confirmed', 'dismissed')),
  kind TEXT NULL CONSTRAINT recurring_overrides_kind CHECK (kind IS NULL OR kind IN ('expense', 'income')),
  day_of_month INTEGER NULL CONSTRAINT recurring_overrides_day CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 1 AND 28)),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS recurring_overrides_status_idx ON recurring_overrides (workspace_id, status);

ALTER TABLE recurring_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recurring_overrides_isolation ON recurring_overrides;
CREATE POLICY recurring_overrides_isolation ON recurring_overrides
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
