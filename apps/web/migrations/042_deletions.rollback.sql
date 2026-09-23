-- Rollback E08-S01b durable deletion. Synthetic pre-release data only.
-- FORBIDDEN once real deletion history exists: rollback can restore code but
-- can never reverse purged data, and tombstones must outlive any restore
-- window (arch 463-464). Disable deletion creation first and never drop
-- accepted tombstones after external use without that export.

DROP TABLE IF EXISTS deletion_tombstones;
DROP TABLE IF EXISTS deletion_requests;
ALTER TABLE workspaces DROP COLUMN IF EXISTS deletion_requested_at;

-- Restore the unconditional E02-S01 immutable-results guard.
CREATE OR REPLACE FUNCTION reject_job_result_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'background_job_results is immutable (E02-S01)';
  RETURN NULL;
END;
$$;
