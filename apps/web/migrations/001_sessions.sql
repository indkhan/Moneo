-- E01-S02: server-checked application sessions. No tenant columns yet (S03
-- owns workspaces/membership/RLS). Session ids are opaque CSPRNG hex; the
-- database never holds tokens, codes or secrets.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_sessions (
  id TEXT PRIMARY KEY,
  keycloak_sub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  CONSTRAINT app_sessions_id_len CHECK (char_length(id) = 64)
);

CREATE INDEX IF NOT EXISTS app_sessions_expires_idx
  ON app_sessions (expires_at) WHERE revoked_at IS NULL;
