-- Epoch 1, Issue 1.4 — idempotent first-login provisioning.
--
-- Why a SECURITY DEFINER function: the app role (`moneo_app`) cannot SELECT
-- the `users` table without workspace context (Issue 1.2 policy
-- `users_select_scoped`), and a brand-new user has no context yet. Rather
-- than widening user reads, provisioning is encapsulated in this
-- owner-executed function. The app role gets EXECUTE only — it can provision
-- the caller, never enumerate users. Fixed `search_path` blocks search-path
-- hijacking, the classic DEFINER pitfall.
--
-- `uuid_generate_v7()` mirrors the application `uuidv7()` (48-bit millis +
-- v7 nibble + variant + random) as a column DEFAULT safety net, so
-- server-side inserts (like the audit row below) stay time-ordered without
-- round-tripping ids. Application code keeps generating ids explicitly.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE sql VOLATILE
SET search_path = public
AS $$
  SELECT (
    lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0')
    || '7' || substr(md5(random()::text), 2, 3)
    || substr('89ab', (floor(random() * 4) + 1)::int, 1) || substr(md5(random()::text), 2, 3)
    || substr(md5(random()::text || clock_timestamp()::text), 1, 12)
  )::uuid
$$;
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN id SET DEFAULT uuid_generate_v7();
--> statement-breakpoint
ALTER TABLE workspaces ALTER COLUMN id SET DEFAULT uuid_generate_v7();
--> statement-breakpoint
ALTER TABLE security_audit_events ALTER COLUMN id SET DEFAULT uuid_generate_v7();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION provision_user_on_login(
  p_auth_subject text,
  p_email text,
  p_display_name text,
  p_workspace_name text,
  p_user_id uuid,
  p_workspace_id uuid
) RETURNS TABLE (
  user_id uuid,
  workspace_id uuid,
  created_user boolean,
  created_workspace boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_workspace_id uuid;
  v_created_user boolean := false;
  v_created_workspace boolean := false;
BEGIN
  IF p_auth_subject IS NULL OR length(p_auth_subject) = 0 OR length(p_auth_subject) > 256 THEN
    RAISE EXCEPTION 'Invalid auth subject' USING ERRCODE = '22023';
  END IF;
  IF p_email IS NOT NULL AND length(p_email) > 320 THEN
    RAISE EXCEPTION 'Email too long' USING ERRCODE = '22023';
  END IF;
  IF p_display_name IS NOT NULL AND length(p_display_name) > 200 THEN
    RAISE EXCEPTION 'Display name too long' USING ERRCODE = '22023';
  END IF;
  IF p_workspace_name IS NOT NULL AND length(p_workspace_name) > 100 THEN
    RAISE EXCEPTION 'Workspace name too long' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Provisioning ids are required' USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent first-logins for the same subject: without this,
  -- two racing logins would each create a workspace (their candidate ids
  -- differ, so no unique conflict would dedupe them). Released at commit.
  PERFORM pg_advisory_xact_lock(42, hashtext(p_auth_subject));

  -- Find-or-create the identity row. ON CONFLICT covers the concurrent
  -- double-login race: the loser re-reads the winner's row.
  SELECT u.id INTO v_user_id FROM users AS u WHERE u.auth_subject = p_auth_subject;
  IF v_user_id IS NULL THEN
    INSERT INTO users (id, auth_subject, email, display_name)
    VALUES (p_user_id, p_auth_subject, nullif(p_email, ''), nullif(p_display_name, ''))
    ON CONFLICT (auth_subject) DO NOTHING
    RETURNING id INTO v_user_id;
    IF v_user_id IS NULL THEN
      SELECT u.id INTO v_user_id FROM users AS u WHERE u.auth_subject = p_auth_subject;
    ELSE
      v_created_user := true;
    END IF;
  ELSE
    -- Returning user: refresh profile prettiness, never blank it with NULLs.
    UPDATE users AS u
    SET email = coalesce(nullif(p_email, ''), u.email),
        display_name = coalesce(nullif(p_display_name, ''), u.display_name),
        updated_at = now()
    WHERE u.id = v_user_id;
  END IF;

  -- Default workspace: oldest membership wins (deterministic); else create
  -- one and make the user its OWNER.
  SELECT m.workspace_id INTO v_workspace_id
  FROM workspace_members AS m
  WHERE m.user_id = v_user_id
  ORDER BY m.created_at ASC, m.workspace_id ASC
  LIMIT 1;
  IF v_workspace_id IS NULL THEN
    INSERT INTO workspaces (id, name, created_by_user_id)
    VALUES (p_workspace_id, coalesce(nullif(p_workspace_name, ''), 'My workspace'), v_user_id)
    ON CONFLICT (id) DO NOTHING
    RETURNING id INTO v_workspace_id;
    -- ON CONFLICT hit means a concurrent login created it; adopt that row.
    IF v_workspace_id IS NULL THEN
      v_workspace_id := p_workspace_id;
    ELSE
      v_created_workspace := true;
    END IF;
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (v_workspace_id, v_user_id, 'OWNER')
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO security_audit_events (workspace_id, user_id, event_type, metadata)
  VALUES (
    v_workspace_id,
    v_user_id,
    CASE WHEN v_created_user THEN 'user.provisioned' ELSE 'user.login' END,
    jsonb_build_object('created_user', v_created_user, 'created_workspace', v_created_workspace)
  );

  RETURN QUERY SELECT v_user_id, v_workspace_id, v_created_user, v_created_workspace;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION provision_user_on_login(text, text, text, text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION provision_user_on_login(text, text, text, text, uuid, uuid) TO moneo_app;
