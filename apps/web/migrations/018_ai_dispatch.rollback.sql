-- E04-S01 rollback: drops the pre-E04 dispatch tables only. Forbidden once
-- real dispatch history exists (forward-fix instead); this rollback is for
-- the synthetic pre-release slice and the tenancy ordered-rollback test.
DROP TABLE IF EXISTS ai_dispatch_usage;
DROP TABLE IF EXISTS ai_dispatch_reservations;
DROP TABLE IF EXISTS ai_dispatch_budgets;
