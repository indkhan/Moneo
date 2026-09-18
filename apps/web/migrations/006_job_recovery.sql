-- E02-S02: fenced recovery, attempt history and durable cancel
-- (architecture ##189, 195, 197, 199-201, 215). Additive over 005 only.
-- attempt_generation on background_jobs is the monotonic fence: every
-- checkpoint/final write commits only when the generation still matches,
-- the job is RUNNING and cancellation has not won. Attempt rows are history
-- and are never deleted on retry. Cancel is cooperative: cancel_requested_at
-- is the durable signal; already-committed effects are never rolled back.
-- Rollback removes the attempts table and the added columns; forbidden once
-- real import history exists (see rollback file).

ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS attempt_generation BIGINT NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'background_jobs_generation_min') THEN
    ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_generation_min CHECK (attempt_generation >= 0);
  END IF;
END $$;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ NULL;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS progress_stage TEXT NULL CONSTRAINT background_jobs_progress_len CHECK (progress_stage IS NULL OR char_length(progress_stage) BETWEEN 1 AND 64);

CREATE TABLE IF NOT EXISTS background_job_attempts (
  workspace_id UUID NOT NULL,
  id UUID NOT NULL,
  background_job_id UUID NOT NULL,
  attempt_no INTEGER NOT NULL CONSTRAINT background_job_attempts_no_min CHECK (attempt_no >= 1),
  generation BIGINT NOT NULL CONSTRAINT background_job_attempts_gen_min CHECK (generation >= 1),
  worker_instance_id TEXT NOT NULL CONSTRAINT background_job_attempts_worker_len CHECK (char_length(worker_instance_id) BETWEEN 1 AND 120),
  bullmq_job_id TEXT NULL CONSTRAINT background_job_attempts_bull_len CHECK (bullmq_job_id IS NULL OR char_length(bullmq_job_id) BETWEEN 1 AND 200),
  checkpoint_stage TEXT NULL CONSTRAINT background_job_attempts_stage_len CHECK (checkpoint_stage IS NULL OR char_length(checkpoint_stage) BETWEEN 1 AND 64),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL CONSTRAINT background_job_attempts_status CHECK (status IN ('RUNNING', 'SUCCEEDED', 'STALE', 'BLOCKED', 'CANCELLED')),
  error_code TEXT NULL,
  error_summary TEXT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, background_job_id, attempt_no),
  FOREIGN KEY (workspace_id, background_job_id) REFERENCES background_jobs (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS background_job_attempts_job_idx ON background_job_attempts (workspace_id, background_job_id, attempt_no);

ALTER TABLE background_job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_job_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS background_job_attempts_isolation ON background_job_attempts;
CREATE POLICY background_job_attempts_isolation ON background_job_attempts
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
