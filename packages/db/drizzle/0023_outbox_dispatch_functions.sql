-- Global outbox dispatch is a narrow capability. The normal moneo_app role
-- remains tenant-scoped; only a separately provisioned dispatcher login may
-- assume this NOLOGIN/NOBYPASSRLS role and execute these owner-run functions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moneo_dispatcher') THEN
    CREATE ROLE moneo_dispatcher NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION claim_outbox_events(p_limit integer)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  aggregate_type text,
  aggregate_id text,
  event_type text,
  payload jsonb,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'Outbox claim limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;

  UPDATE outbox_events
  SET status = 'pending', claimed_at = NULL
  WHERE status = 'claimed' AND claimed_at < now() - interval '5 minutes';

  RETURN QUERY
  WITH picked AS (
    SELECT event.id
    FROM outbox_events AS event
    WHERE event.status = 'pending' AND event.next_attempt_at <= now()
    ORDER BY event.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE outbox_events AS event
  SET status = 'claimed', claimed_at = now(), attempts = event.attempts + 1
  FROM picked
  WHERE event.id = picked.id
  RETURNING event.id, event.workspace_id, event.aggregate_type, event.aggregate_id,
    event.event_type, event.payload, event.attempts;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mark_outbox_events_published(p_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE outbox_events
  SET status = 'published', published_at = now(), claimed_at = NULL, last_error = NULL
  WHERE id = ANY(p_ids) AND status = 'claimed'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION retry_outbox_event(p_id uuid, p_message text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE outbox_events
  SET status = 'pending', claimed_at = NULL, last_error = left(p_message, 1000),
      next_attempt_at = now() + interval '5 seconds'
  WHERE id = p_id AND status = 'claimed'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_outbox_events(integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION mark_outbox_events_published(uuid[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION retry_outbox_event(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_outbox_events(integer) TO moneo_dispatcher;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mark_outbox_events_published(uuid[]) TO moneo_dispatcher;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION retry_outbox_event(uuid, text) TO moneo_dispatcher;
