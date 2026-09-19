-- E04-S02: persistent chat with a worker-owned model loop (product §4;
-- architecture §§139-174, 175-226; E02 durable job/fencing and E04-S01
-- dispatch). Threads, turns and generation attempts are append-mostly tenant
-- rows; activity is append-only with a per-thread resumable cursor. One
-- durable background job (new chat.generate type on the existing jobs
-- machinery) owns generation; attempt fencing plus the S01 reservation make
-- redelivery converge on at most one published assistant turn. Composite
-- keys per §27; FORCE RLS per §23. Rollback drops these pre-E04 tables and
-- restores the jobs type check; forbidden once real conversations exist.

ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start', 'chat.generate'));

CREATE TABLE IF NOT EXISTS chat_threads (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  title TEXT NOT NULL DEFAULT '' CONSTRAINT chat_threads_title_len CHECK (char_length(title) BETWEEN 0 AND 200),
  status TEXT NOT NULL DEFAULT 'open' CONSTRAINT chat_threads_status CHECK (status IN ('open', 'archived')),
  created_by UUID NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

-- Turns are append-only: bodies are written once (user body at send,
-- assistant body at fenced publish) and never rewritten; status moves
-- forward queued -> running -> completed|interrupted|failed|cancelled.
CREATE TABLE IF NOT EXISTS chat_turns (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  thread_id UUID NOT NULL,
  role TEXT NOT NULL CONSTRAINT chat_turns_role CHECK (role IN ('user', 'assistant')),
  status TEXT NOT NULL CONSTRAINT chat_turns_status CHECK (status IN ('queued', 'running', 'completed', 'interrupted', 'failed', 'cancelled')),
  body TEXT NOT NULL DEFAULT '',
  job_id UUID NULL,
  idempotency_key TEXT NULL CONSTRAINT chat_turns_key_len CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, thread_id) REFERENCES chat_threads (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chat_turns_thread_idx ON chat_turns (workspace_id, thread_id, created_at, id);

-- One row per generation attempt of an assistant turn. output_text is
-- non-authoritative attempt activity (the final message or complete chunks
-- of one attempt); only the fenced publish promotes it onto the turn.
-- Never concatenate independent attempts: retry always inserts a new row.
CREATE TABLE IF NOT EXISTS chat_attempts (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  turn_id UUID NOT NULL,
  generation INTEGER NOT NULL CONSTRAINT chat_attempts_gen_min CHECK (generation >= 1),
  status TEXT NOT NULL CONSTRAINT chat_attempts_status CHECK (status IN ('running', 'published', 'interrupted', 'failed', 'cancelled')),
  reservation_id UUID NULL,
  policy_version BIGINT NULL CONSTRAINT chat_attempts_version_min CHECK (policy_version IS NULL OR policy_version >= 1),
  output_text TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, turn_id) REFERENCES chat_turns (workspace_id, id) ON DELETE CASCADE
);
-- One active generation per turn (hence per thread): the backstop behind the
-- send-time thread_busy gate and the fenced publish.
CREATE UNIQUE INDEX IF NOT EXISTS chat_attempts_active_idx ON chat_attempts (workspace_id, turn_id) WHERE status = 'running';

-- Append-only activity with a per-thread sequence cursor. Payloads carry
-- state-transition metadata (turn/attempt ids, states, counts) only — never
-- finance rows, prompts or provider transcripts; bodies live on turns.
CREATE TABLE IF NOT EXISTS chat_activity (
  workspace_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  seq BIGINT NOT NULL CONSTRAINT chat_activity_seq_min CHECK (seq >= 1),
  kind TEXT NOT NULL CONSTRAINT chat_activity_kind CHECK (kind IN ('user-turn', 'assistant-queued', 'assistant-running', 'assistant-published', 'assistant-interrupted', 'assistant-failed', 'assistant-cancelled', 'retry')),
  turn_id UUID NULL,
  attempt_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, thread_id, seq),
  FOREIGN KEY (workspace_id, thread_id) REFERENCES chat_threads (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_threads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_threads_isolation ON chat_threads;
CREATE POLICY chat_threads_isolation ON chat_threads
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE chat_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_turns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_turns_isolation ON chat_turns;
CREATE POLICY chat_turns_isolation ON chat_turns
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE chat_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_attempts_isolation ON chat_attempts;
CREATE POLICY chat_attempts_isolation ON chat_attempts
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE chat_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_activity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_activity_isolation ON chat_activity;
CREATE POLICY chat_activity_isolation ON chat_activity
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
