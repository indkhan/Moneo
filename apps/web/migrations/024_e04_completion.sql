ALTER TABLE ai_action_proposals
  ADD COLUMN IF NOT EXISTS policy_version BIGINT NOT NULL DEFAULT 1
  CONSTRAINT ai_action_proposals_policy_version_min CHECK (policy_version >= 1);

ALTER TABLE ai_eval_cases ADD COLUMN IF NOT EXISTS input_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ai_eval_cases ADD COLUMN IF NOT EXISTS expected_tools JSONB NOT NULL DEFAULT '[]'::jsonb;
