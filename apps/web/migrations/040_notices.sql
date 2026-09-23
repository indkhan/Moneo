-- E07-S04: per-user, workspace-keyed in-app notices for terminal job
-- outcomes (import/analysis/chat/artifact completion or failure).
-- One row per (workspace, user, source event): the UNIQUE source event makes
-- the outbox-terminal producer idempotent, so reload, refresh and Redis
-- event loss converge on exactly one notice without restarting work.
-- Notices carry a short safe title/body (<=500 visible chars, enforced by
-- CHECK) plus an optional tenant-relative link (validated at the app layer;
-- never a secret or raw payload). Read state is a nullable read_at.
-- Composite tenant keys and composite FKs keep every notice inside its own
-- workspace; FORCE RLS with the NULLIF guard (033 precedent) fails closed to
-- zero rows under empty context. Additive only; rollback drops this
-- pre-history table only and is forbidden once member notices exist in real
-- use without an export (see rollback file): accepted notices are retained
-- after external use.

CREATE TABLE IF NOT EXISTS notices (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  source_event TEXT NOT NULL CONSTRAINT notices_source_len CHECK (char_length(source_event) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CONSTRAINT notices_kind CHECK (kind IN ('import_completed', 'import_failed', 'analysis_completed', 'analysis_failed', 'chat_completed', 'chat_failed', 'artifact_completed', 'artifact_failed')),
  title TEXT NOT NULL CONSTRAINT notices_title_len CHECK (char_length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL CONSTRAINT notices_body_len CHECK (char_length(body) BETWEEN 1 AND 500),
  link_href TEXT NULL CONSTRAINT notices_link_len CHECK (link_href IS NULL OR char_length(link_href) BETWEEN 1 AND 500),
  read_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, id),
  UNIQUE (workspace_id, user_id, source_event)
);

ALTER TABLE notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE notices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON notices;
CREATE POLICY workspace_isolation ON notices
    USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
    WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

CREATE INDEX IF NOT EXISTS notices_unread_idx ON notices (workspace_id, user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notices_recent_idx ON notices (workspace_id, user_id, created_at DESC);
