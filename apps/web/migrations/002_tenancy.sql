-- E01-S03: tenant ownership. Composite keys and same-workspace FKs per
-- architecture §27 from this first tenant migration; ENABLE + FORCE RLS per
-- §23 with transaction-local app.current_workspace / app.current_user.
-- accounts carries id/name only (no money columns; S04/E03-S01 extend it).
-- No GRANTs here: dev/test databases are app-owned; the deployment GRANT
-- split to a least-privilege app role arrives with the staging-identity
-- story (recorded limitation in STORIES.md E01-S03).
--
-- users deliberately carries NO RLS: it is the identity anchor (id,
-- auth_subject, timestamps — no tenant or finance data). Every access is
-- explicitly scoped by the verified session subject in application code, and
-- RLS on users would block exactly that session-to-user lookup. Tenant
-- isolation is enforced at workspaces/members/accounts below.
-- The NULLIF guard keeps an empty/unset context as NULL so comparisons fail
-- closed to zero rows instead of erroring on ''::uuid.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  auth_subject TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CONSTRAINT workspaces_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
  base_currency_code CHAR(3) NOT NULL CONSTRAINT workspaces_currency_fmt CHECK (base_currency_code ~ '^[A-Z]{3}$'),
  timezone TEXT NOT NULL DEFAULT 'UTC' CONSTRAINT workspaces_tz_len CHECK (char_length(timezone) BETWEEN 1 AND 64),
  locale TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CONSTRAINT workspace_members_role CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS accounts (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id UUID NOT NULL,
  name TEXT NOT NULL CONSTRAINT accounts_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

-- Strict workspace equality (architecture §23 literal): the tightest table
-- (accounts) and the write path of every table admit only the context
-- workspace. Context is set only by withTenant after a membership check, so
-- equality here is the second layer, not the first.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_isolation ON workspaces;
CREATE POLICY workspaces_isolation ON workspaces
  USING (id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
-- Membership read path: lets a user-context-only transaction list the
-- workspaces it belongs to (used by listWorkspaces). SELECT-only; writes
-- still require the exact workspace context above.
DROP POLICY IF EXISTS workspaces_membership_read ON workspaces;
CREATE POLICY workspaces_membership_read ON workspaces FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = workspaces.id
      AND m.user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
  ));

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_members_isolation ON workspace_members;
CREATE POLICY workspace_members_isolation ON workspace_members
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
-- Own-membership read path: a user-context-only transaction sees its own
-- membership rows (used by listWorkspaces). SELECT-only.
DROP POLICY IF EXISTS workspace_members_own_read ON workspace_members;
CREATE POLICY workspace_members_own_read ON workspace_members FOR SELECT
  USING (user_id = NULLIF(current_setting('app.current_user', true), '')::uuid);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounts_isolation ON accounts;
CREATE POLICY accounts_isolation ON accounts
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);
