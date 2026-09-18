-- E02-S03: quarantine upload + bounded parse staging (architecture ##5-9
-- adapted to composite tenant keys, ##181-183, 202, 216-218, 443-446,
-- 455-456). Tenant-keyed data_sources/imports/source-objects plus staged
-- parsed observations addressed by stable (import,row). Original bytes live
-- ONLY in the private quarantine object prefix under generated keys; the
-- database keeps metadata, hashes and staged cells. Parsed ambiguity stays
-- staged here — no canonical transactions yet (S05 owns them).
-- Also admits the imports.parse job type and import-parsed result kind for
-- the S03 worker slice. Rollback drops these empty pre-data tables only;
-- forbidden after real import history exists (see rollback file).

ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start', 'imports.parse'));
ALTER TABLE background_job_results DROP CONSTRAINT IF EXISTS background_job_results_kind;
ALTER TABLE background_job_results ADD CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop', 'import-parsed'));

CREATE TABLE IF NOT EXISTS data_sources (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  type TEXT NOT NULL CONSTRAINT data_sources_type CHECK (type IN ('csv_upload', 'xlsx_upload')),
  name TEXT NOT NULL CONSTRAINT data_sources_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
  status TEXT NOT NULL CONSTRAINT data_sources_status CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS imports (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  data_source_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CONSTRAINT imports_key_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  file_name TEXT NOT NULL CONSTRAINT imports_file_len CHECK (char_length(file_name) BETWEEN 1 AND 200),
  file_sha256 TEXT NOT NULL CONSTRAINT imports_sha_len CHECK (char_length(file_sha256) = 64),
  object_key TEXT NOT NULL CONSTRAINT imports_object_len CHECK (char_length(object_key) BETWEEN 1 AND 400),
  parser_version TEXT NOT NULL CONSTRAINT imports_parser_len CHECK (char_length(parser_version) BETWEEN 1 AND 32),
  status TEXT NOT NULL CONSTRAINT imports_status CHECK (status IN ('UPLOAD_REGISTERED', 'SCANNING', 'PARSING', 'STAGED', 'REJECTED')),
  row_count INTEGER NULL CONSTRAINT imports_row_min CHECK (row_count IS NULL OR row_count >= 0),
  staged_count INTEGER NULL CONSTRAINT imports_staged_min CHECK (staged_count IS NULL OR staged_count >= 0),
  review_count INTEGER NULL CONSTRAINT imports_review_min CHECK (review_count IS NULL OR review_count >= 0),
  rejected_count INTEGER NULL CONSTRAINT imports_rejected_min CHECK (rejected_count IS NULL OR rejected_count >= 0),
  parsed_rows INTEGER NOT NULL DEFAULT 0 CONSTRAINT imports_parsed_min CHECK (parsed_rows >= 0),
  error_code TEXT NULL,
  error_summary TEXT NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  -- Retention marker: original bytes expire ~30 days after validation per
  -- arch #455; enforcement + legal sign-off arrive with E08, not here.
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, data_source_id) REFERENCES data_sources (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS imports_source_idx ON imports (workspace_id, data_source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS source_objects (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  import_id UUID NOT NULL,
  object_key TEXT NOT NULL CONSTRAINT source_objects_key_len CHECK (char_length(object_key) BETWEEN 1 AND 400),
  size_bytes BIGINT NOT NULL CONSTRAINT source_objects_size_min CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CONSTRAINT source_objects_sha_len CHECK (char_length(sha256) = 64),
  status TEXT NOT NULL CONSTRAINT source_objects_status CHECK (status IN ('QUARANTINED', 'CLEAN', 'INFECTED', 'ACCEPTED')),
  scan_detail TEXT NULL,
  scanned_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, import_id),
  FOREIGN KEY (workspace_id, import_id) REFERENCES imports (workspace_id, id) ON DELETE CASCADE
);

-- Staged parsed observations with stable (import,row) identity: retries and
-- chunked resume converge via ON CONFLICT DO NOTHING, never duplicates.
CREATE TABLE IF NOT EXISTS parsed_observations (
  workspace_id UUID NOT NULL,
  import_id UUID NOT NULL,
  row_no INTEGER NOT NULL CONSTRAINT parsed_observations_row_min CHECK (row_no >= 1),
  status TEXT NOT NULL CONSTRAINT parsed_observations_status CHECK (status IN ('STAGED', 'NEEDS_REVIEW', 'REJECTED')),
  observation_id TEXT NOT NULL CONSTRAINT parsed_observations_oid_len CHECK (char_length(observation_id) BETWEEN 1 AND 64),
  amount_minor TEXT NULL,
  currency TEXT NULL,
  direction TEXT NULL CONSTRAINT parsed_observations_dir CHECK (direction IS NULL OR direction IN ('INFLOW', 'OUTFLOW')),
  effective_date TEXT NULL,
  description TEXT NULL,
  reasons JSONB NULL,
  raw_cells JSONB NULL,
  source_sheet TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, import_id, row_no),
  FOREIGN KEY (workspace_id, import_id) REFERENCES imports (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS parsed_observations_status_idx ON parsed_observations (workspace_id, import_id, status, row_no);

ALTER TABLE data_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_sources_isolation ON data_sources;
CREATE POLICY data_sources_isolation ON data_sources
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS imports_isolation ON imports;
CREATE POLICY imports_isolation ON imports
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE source_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS source_objects_isolation ON source_objects;
CREATE POLICY source_objects_isolation ON source_objects
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE parsed_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE parsed_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS parsed_observations_isolation ON parsed_observations;
CREATE POLICY parsed_observations_isolation ON parsed_observations
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
