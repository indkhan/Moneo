-- Epoch 1, Issue 1.7 — server-side session registry.
--
-- The browser cookie is opaque and revocable only if the server tracks
-- sessions. `sessions` holds one row per login (never deleted on revoke —
-- revoked rows persist for audit). RLS is enabled with NO app-role policy:
-- the app role reaches sessions exclusively through the three DEFINER
-- functions below, each keyed by the user id from the SEALED session cookie
-- (server-asserted, never client-supplied identity beyond that). Fixed
-- `search_path` on every function, PUBLIC execute revoked throughout.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces (id) ON DELETE SET NULL,
  user_agent text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_at timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX sessions_user_active_idx ON sessions (user_id, created_at) WHERE revoked_at IS NULL;
--> statement-breakpoint
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE sessions TO moneo_app;
--> statement-breakpoint
-- Register a login. Only workspace members may hold sessions there; a repeat
-- registration refreshes activity instead of duplicating.
CREATE OR REPLACE FUNCTION register_session(
  p_session_id uuid,
  p_user_id uuid,
  p_workspace_id uuid,
  p_user_agent text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_session_id IS NULL OR p_user_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Session registration ids are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not a workspace member' USING ERRCODE = '28000';
  END IF;
  INSERT INTO sessions (id, user_id, workspace_id, user_agent)
  VALUES (p_session_id, p_user_id, p_workspace_id, left(nullif(p_user_agent, ''), 200))
  ON CONFLICT (id) DO UPDATE SET last_seen_at = now();
END;
$$;
--> statement-breakpoint
-- List the caller's own ACTIVE sessions, newest first. Revoked rows stay in
-- the table for audit but are invisible here.
CREATE OR REPLACE FUNCTION list_user_sessions(p_user_id uuid)
RETURNS TABLE (
  session_id uuid,
  workspace_id uuid,
  user_agent text,
  created_at timestamp with time zone,
  last_seen_at timestamp with time zone
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, workspace_id, user_agent, created_at, last_seen_at
  FROM sessions
  WHERE user_id = p_user_id AND revoked_at IS NULL
  ORDER BY created_at DESC;
$$;
--> statement-breakpoint
-- Revoke the caller's sessions and return the count:
-- * `p_only_session_id` set → revoke exactly that owned session ("Revoke" button).
-- * otherwise revoke all except `p_keep_session_id` ("sign out other
--   sessions"); `p_keep_session_id` NULL revokes everything (full sign-out,
--   the route clears the caller's cookie right after).
CREATE OR REPLACE FUNCTION revoke_user_sessions(
  p_user_id uuid,
  p_keep_session_id uuid,
  p_only_session_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_revoked integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User id is required' USING ERRCODE = '22023';
  END IF;
  IF p_only_session_id IS NOT NULL THEN
    UPDATE sessions
    SET revoked_at = now()
    WHERE user_id = p_user_id AND id = p_only_session_id AND revoked_at IS NULL;
  ELSE
    UPDATE sessions
    SET revoked_at = now()
    WHERE user_id = p_user_id
      AND revoked_at IS NULL
      AND (p_keep_session_id IS NULL OR id <> p_keep_session_id);
  END IF;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  RETURN v_revoked;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION register_session(uuid, uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_user_sessions(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION revoke_user_sessions(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION register_session(uuid, uuid, uuid, text) TO moneo_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_user_sessions(uuid) TO moneo_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION revoke_user_sessions(uuid, uuid, uuid) TO moneo_app;
