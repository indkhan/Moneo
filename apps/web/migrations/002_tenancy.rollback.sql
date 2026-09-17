-- E01-S03 rollback: removes tenant ownership (destroys synthetic tenant
-- rows; no production data exists at this slice). Run only with the
-- matching app version, then re-migrate to restore an empty shape.
-- Policies first: workspaces_membership_read depends on workspace_members,
-- so dropping tables alone fails on the policy dependency.
DROP POLICY IF EXISTS accounts_isolation ON accounts;
DROP POLICY IF EXISTS workspace_members_isolation ON workspace_members;
DROP POLICY IF EXISTS workspace_members_own_read ON workspace_members;
DROP POLICY IF EXISTS workspaces_isolation ON workspaces;
DROP POLICY IF EXISTS workspaces_membership_read ON workspaces;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS workspace_members;
DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS users;
-- Child-first table order satisfies the FKs (accounts/members reference
-- workspaces/users); verified by the suite rollback test.
DELETE FROM schema_migrations WHERE version = '002_tenancy';
