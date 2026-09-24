-- Rollback for E03-S04 calculation evidence
DROP POLICY IF EXISTS workspace_data_revision_isolation ON workspace_data_revision;
DROP TABLE IF EXISTS workspace_data_revision;