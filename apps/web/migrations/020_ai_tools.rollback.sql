-- E04-S03 rollback: drops the pre-E04 tool-call record only. Forbidden once
-- real tool history exists (forward-fix instead); this rollback is for the
-- synthetic pre-release slice and the tenancy ordered-rollback test.
DROP TABLE IF EXISTS chat_tool_calls;
