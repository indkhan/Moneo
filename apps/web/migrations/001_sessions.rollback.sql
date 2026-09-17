-- E01-S02 rollback: drops server sessions (forces re-login; no tenant data
-- exists yet at this slice). Run only with the matching app version.
DROP TABLE IF EXISTS app_sessions;
DELETE FROM schema_migrations WHERE version = '001_sessions';
