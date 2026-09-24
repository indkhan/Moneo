-- E05-S06: AI run linkage for artifact proposals + thread artifact context.
-- Additive only. ai_run_id references the builder dispatch reservation that
-- produced the proposal (usage/cost stay in ai_dispatch_usage).

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS ai_run_id UUID NULL;
ALTER TABLE artifact_versions ADD COLUMN IF NOT EXISTS ai_run_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_ai_run_fk') THEN
    ALTER TABLE artifacts ADD CONSTRAINT artifacts_ai_run_fk
      FOREIGN KEY (workspace_id, ai_run_id) REFERENCES ai_dispatch_reservations (workspace_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifact_versions_ai_run_fk') THEN
    ALTER TABLE artifact_versions ADD CONSTRAINT artifact_versions_ai_run_fk
      FOREIGN KEY (workspace_id, ai_run_id) REFERENCES ai_dispatch_reservations (workspace_id, id);
  END IF;
END $$;

-- Normal-chat artifact context link: the thread an artifact proposal came from.
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS artifact_id UUID NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_threads_artifact_fk') THEN
    ALTER TABLE chat_threads ADD CONSTRAINT chat_threads_artifact_fk
      FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id);
  END IF;
END $$;

-- Idempotent AI proposals: same key replays the same artifact/version,
-- same key with different bytes conflicts. Failed validations are recorded
-- without creating versions.
CREATE TABLE IF NOT EXISTS artifact_ai_proposals (
    workspace_id UUID NOT NULL,
    idempotency_key TEXT NOT NULL CONSTRAINT artifact_ai_proposals_key_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
    request_hash TEXT NOT NULL DEFAULT '',
    artifact_id UUID NULL,
    version_id UUID NULL,
    kind TEXT NOT NULL CONSTRAINT artifact_ai_proposals_kind CHECK (kind IN ('create', 'edit')),
    status TEXT NOT NULL CONSTRAINT artifact_ai_proposals_status CHECK (status IN ('proposed', 'failed')),
    error_class TEXT NULL,
    ai_run_id UUID NULL,
    thread_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, idempotency_key)
);

ALTER TABLE artifact_ai_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_ai_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS artifact_ai_proposals_isolation ON artifact_ai_proposals;
CREATE POLICY artifact_ai_proposals_isolation ON artifact_ai_proposals
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

-- Chat activity kinds for artifact proposal visibility in the normal panel.
ALTER TABLE chat_activity DROP CONSTRAINT IF EXISTS chat_activity_kind;
ALTER TABLE chat_activity ADD CONSTRAINT chat_activity_kind CHECK (kind IN ('user-turn', 'assistant-queued', 'assistant-running', 'assistant-published', 'assistant-interrupted', 'assistant-failed', 'assistant-cancelled', 'retry', 'artifact-proposed', 'artifact-failed'));
