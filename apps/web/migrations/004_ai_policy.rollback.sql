-- E01-S05 rollback: removes AI policy state (synthetic only at this slice).
-- Run only with the matching app version, then re-migrate to restore.
DROP POLICY IF EXISTS ai_permits_isolation ON ai_dispatch_permits;
DROP POLICY IF EXISTS ai_exclusions_isolation ON ai_exclusions;
DROP POLICY IF EXISTS ai_policies_isolation ON ai_policies;
DROP TABLE IF EXISTS ai_dispatch_permits;
DROP TABLE IF EXISTS ai_exclusions;
DROP TABLE IF EXISTS ai_policies;
DELETE FROM schema_migrations WHERE version = '004_ai_policy';
