-- E02-S04: deterministic-first mapping with bounded model assistance
-- (architecture ##53, 74, 76, 190-192; product ##6.1, 7, 16). Versioned
-- mapping proposals/profiles plus provider reservation/usage rows scoped by
-- workspace/import. Models never authorize canonical money: every proposal
-- carries the deterministic validation verdict, and publication revalidates
-- the AI-policy permit version. No canonical transaction writes here (S05).
-- Rollback drops these empty pre-data tables only; forbidden after real
-- mapping history exists (see rollback file).

-- Admitted header captured at parse-terminal time for mapping samples.
ALTER TABLE imports ADD COLUMN IF NOT EXISTS source_columns JSONB NULL;

-- Versioned reusable column profiles: one immutable row per
-- (workspace, name, version); new versions supersede, never mutate.
CREATE TABLE IF NOT EXISTS mapping_profiles (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  name TEXT NOT NULL CONSTRAINT mapping_profiles_name_len CHECK (char_length(name) BETWEEN 1 AND 120),
  version INTEGER NOT NULL CONSTRAINT mapping_profiles_version_min CHECK (version >= 1),
  profile JSONB NOT NULL,
  created_from TEXT NOT NULL CONSTRAINT mapping_profiles_from CHECK (created_from IN ('deterministic', 'model-assisted', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, name, version)
);

-- One proposal per mapping attempt; ACCEPTED is terminal per import until a
-- newer proposal supersedes it (domain-enforced, single writer per accept).
CREATE TABLE IF NOT EXISTS mapping_proposals (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  import_id UUID NOT NULL,
  profile JSONB NOT NULL,
  account_id UUID NULL,
  path TEXT NOT NULL CONSTRAINT mapping_proposals_path CHECK (path IN ('deterministic', 'model-assisted', 'manual')),
  status TEXT NOT NULL CONSTRAINT mapping_proposals_status CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_version BIGINT NULL,
  permit_id UUID NULL,
  reservation_id UUID NULL,
  model TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, import_id) REFERENCES imports (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS mapping_proposals_import_idx ON mapping_proposals (workspace_id, import_id, status, created_at DESC);

-- Bounded provider reservation: the hard token ceiling is claimed BEFORE
-- dispatch; one attempt plus one retry share the same reservation.
CREATE TABLE IF NOT EXISTS mapping_provider_reservations (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  import_id UUID NOT NULL,
  purpose TEXT NOT NULL CONSTRAINT mapping_reservations_purpose CHECK (purpose IN ('import-mapping')),
  input_ceiling INTEGER NOT NULL CONSTRAINT mapping_reservations_in CHECK (input_ceiling BETWEEN 1 AND 8000),
  output_ceiling INTEGER NOT NULL CONSTRAINT mapping_reservations_out CHECK (output_ceiling BETWEEN 1 AND 2000),
  status TEXT NOT NULL CONSTRAINT mapping_reservations_status CHECK (status IN ('RESERVED', 'CONSUMED', 'RELEASED', 'EXPIRED')),
  model TEXT NOT NULL CONSTRAINT mapping_reservations_model_len CHECK (char_length(model) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, import_id) REFERENCES imports (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mapping_reservations_active_idx ON mapping_provider_reservations (workspace_id, import_id, status, expires_at);

-- Provider usage: recorded per response; unknown cost stays pending, never
-- zero (cost_unknown=true with NULL tokens).
CREATE TABLE IF NOT EXISTS mapping_provider_usage (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  model TEXT NOT NULL CONSTRAINT mapping_usage_model_len CHECK (char_length(model) BETWEEN 1 AND 200),
  input_tokens INTEGER NULL CONSTRAINT mapping_usage_in_min CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER NULL CONSTRAINT mapping_usage_out_min CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_unknown BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, reservation_id) REFERENCES mapping_provider_reservations (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE mapping_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapping_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mapping_profiles_isolation ON mapping_profiles;
CREATE POLICY mapping_profiles_isolation ON mapping_profiles
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE mapping_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapping_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mapping_proposals_isolation ON mapping_proposals;
CREATE POLICY mapping_proposals_isolation ON mapping_proposals
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE mapping_provider_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapping_provider_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mapping_reservations_isolation ON mapping_provider_reservations;
CREATE POLICY mapping_reservations_isolation ON mapping_provider_reservations
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE mapping_provider_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapping_provider_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mapping_usage_isolation ON mapping_provider_usage;
CREATE POLICY mapping_usage_isolation ON mapping_provider_usage
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
