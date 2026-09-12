-- Epoch 1, Issue 1.2 — workspace RLS and runtime DB roles.
--
-- Roles:
--   * `moneo_app` (created below, NOBYPASSRLS) is the ONLY role the web/worker
--     runtime ever uses. Staging/prod pools connect with its credentials
--     (password provisioned out-of-band, never in this repo).
--   * The migration/owner role behind DATABASE_MIGRATION_URL runs
--     `pnpm db:migrate` and ops only. It owns the schema, so it bypasses RLS
--     by ownership — that is intentional and confined to releases.
--   * Local docker-compose keeps the `moneo` superuser for convenience; the
--     RLS policies below still apply to every connection acting as moneo_app.
--
-- Tenant context: every tenant-domain query runs inside
-- `withWorkspaceTransaction`, which sets transaction-local
-- `app.current_workspace`. A missing context compares NULL and matches
-- nothing, so access fails closed (deny by default, never error-to-open).
-- `currencies` stays policy-free: it is global reference data.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moneo_app') THEN
    CREATE ROLE moneo_app LOGIN NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO moneo_app;
--> statement-breakpoint
GRANT SELECT ON TABLE currencies TO moneo_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users, workspaces, workspace_members, security_audit_events TO moneo_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO moneo_app;
--> statement-breakpoint
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE security_audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- users: readable only when the row shares a workspace with the caller.
-- Provisioning inserts the row before any membership exists, so INSERT is
-- open to the app role; UPDATE/DELETE stay denied (no policy = deny).
CREATE POLICY users_select_scoped ON users FOR SELECT TO moneo_app
  USING (EXISTS (
    SELECT 1 FROM workspace_members AS m
    WHERE m.user_id = users.id
      AND m.workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid
  ));
--> statement-breakpoint
CREATE POLICY users_insert_provisioning ON users FOR INSERT TO moneo_app WITH CHECK (true);
--> statement-breakpoint
-- workspaces: the current workspace row is visible; creation is open so
-- first-login provisioning can create it before setting tenant context.
CREATE POLICY workspaces_isolation ON workspaces FOR ALL TO moneo_app
  USING (id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (true);
--> statement-breakpoint
-- workspace_members: strictly bound to the current workspace on read and write.
CREATE POLICY workspace_members_isolation ON workspace_members FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
-- security_audit_events: strictly bound to the current workspace.
-- Workspace-less (global) events stay visible to the migration/owner role only.
CREATE POLICY security_audit_events_isolation ON security_audit_events FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
