-- E01-S04 rollback: removes the command journal and account versions
-- (synthetic data only at this slice). Run only with the matching app
-- version, then re-migrate to restore the empty shape.
DROP POLICY IF EXISTS command_operations_isolation ON command_operations;
DROP TABLE IF EXISTS command_operations;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_version_min;
ALTER TABLE accounts DROP COLUMN IF EXISTS version;
DELETE FROM schema_migrations WHERE version = '003_commands';
