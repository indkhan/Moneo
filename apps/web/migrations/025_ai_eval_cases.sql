ALTER TABLE ai_eval_cases ADD COLUMN IF NOT EXISTS input_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ai_eval_cases ADD COLUMN IF NOT EXISTS expected_tools JSONB NOT NULL DEFAULT '[]'::jsonb;
