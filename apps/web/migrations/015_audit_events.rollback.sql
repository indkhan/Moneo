-- E03-S05 rollback: audit_events
-- Drop code first (commands/routes), then schema. Forbidden after real audit history exists.

DROP TABLE IF EXISTS audit_events;