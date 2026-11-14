-- One organize and analysis pass per workspace. Imports and bank syncs request a pass instead of each starting one:
-- a request while a run works records which trigger asked (rerun_trigger), so exactly one follow-up runs after it.
-- data_fingerprint is what the analysis agents saw; a pass whose data matches the last completed analysis skips them.
-- organize_after: rows the organizer left blank (a plan limit, a spent budget) wait until then, and the hourly check retries them.
alter table public.agent_runs
  add column rerun_trigger text check (rerun_trigger in ('import','sync')),
  add column data_fingerprint text check (char_length(data_fingerprint) <= 200),
  add column organize_after timestamptz;

-- Changes whenever a row lands, changes (every write bumps version, labels included) or is removed.
create function public.agent_data_fingerprint(p_workspace_id uuid) returns text
language sql stable security definer set search_path='' as $$
  select count(*)::text || ':' || coalesce(sum(version::bigint), 0)::text || ':' || coalesce(max(created_at)::text, '')
    from public.transactions where workspace_id = p_workspace_id;
$$;
revoke all on function public.agent_data_fingerprint(uuid) from public, anon, authenticated;
grant execute on function public.agent_data_fingerprint(uuid) to service_role;
