-- E05-S06 rollback: drop proposal table, restore activity kinds, drop linkage.
ALTER TABLE chat_activity DROP CONSTRAINT IF EXISTS chat_activity_kind;
ALTER TABLE chat_activity ADD CONSTRAINT chat_activity_kind CHECK (kind IN ('user-turn', 'assistant-queued', 'assistant-running', 'assistant-published', 'assistant-interrupted', 'assistant-failed', 'assistant-cancelled', 'retry'));
DROP TABLE IF EXISTS artifact_ai_proposals CASCADE;
ALTER TABLE chat_threads DROP CONSTRAINT IF EXISTS chat_threads_artifact_fk;
ALTER TABLE chat_threads DROP COLUMN IF EXISTS artifact_id;
ALTER TABLE artifact_versions DROP CONSTRAINT IF EXISTS artifact_versions_ai_run_fk;
ALTER TABLE artifact_versions DROP COLUMN IF EXISTS ai_run_id;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_ai_run_fk;
ALTER TABLE artifacts DROP COLUMN IF EXISTS ai_run_id;
