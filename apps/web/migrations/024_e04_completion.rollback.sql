ALTER TABLE ai_action_proposals DROP COLUMN IF EXISTS policy_version;
ALTER TABLE ai_eval_cases DROP COLUMN IF EXISTS expected_tools;
ALTER TABLE ai_eval_cases DROP COLUMN IF EXISTS input_payload;
