-- E08-S01c-L local retention enforcement (architecture ##455-456).
-- 1. imports.retain_original: explicit user hold on original bytes (purge
--    skips held rows indefinitely; unsetting the hold needs no re-index
--    because held rows keep their expiry-index entry and are rechecked).
-- 2. export_expiry_index / import_expiry_index: ID-only discovery tables
--    (UUIDs + expiry instants, no finance/personal content) WITHOUT RLS, by
--    the same rationale as job_dispatch_index — the cross-workspace sweeper
--    must find due packages/imports without an unscoped tenant-table read.
--    Every sweep step re-enters a workspace-scoped context bound to the
--    index row. Tombstones are deliberately absent from every index: no
--    sweep may ever delete them.
-- Backfill covers already-marked rows (synthetic pre-release data only).
-- Rollback drops the indexes/column. S01c-D owns scheduler cadence and all
-- backup/audit/processor periods.

ALTER TABLE imports ADD COLUMN IF NOT EXISTS retain_original BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS export_expiry_index (
  workspace_id UUID NOT NULL,
  package_id UUID NOT NULL,
  requested_by UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, package_id)
);
CREATE INDEX IF NOT EXISTS export_expiry_index_due_idx ON export_expiry_index (expires_at);

CREATE TABLE IF NOT EXISTS import_expiry_index (
  workspace_id UUID NOT NULL,
  import_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, import_id)
);
CREATE INDEX IF NOT EXISTS import_expiry_index_due_idx ON import_expiry_index (expires_at);

-- Backfill markers already set by the STAGED path (synthetic only).
INSERT INTO export_expiry_index (workspace_id, package_id, requested_by, expires_at)
  SELECT workspace_id, id, requested_by, expires_at FROM export_packages WHERE status = 'BUILDING' OR status = 'READY'
  ON CONFLICT DO NOTHING;
INSERT INTO import_expiry_index (workspace_id, import_id, expires_at)
  SELECT workspace_id, id, expires_at FROM imports WHERE expires_at IS NOT NULL
  ON CONFLICT DO NOTHING;
