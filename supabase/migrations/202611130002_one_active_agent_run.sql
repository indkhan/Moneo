-- At most one queued or running agent run per workspace: imports, bank syncs, the backlog check and
-- manual starts all reuse the active run. Older duplicates are canceled first; they can be resumed later.
with ranked as (
  select id, row_number() over (partition by workspace_id order by created_at desc, id desc) as position
  from public.agent_runs where status in ('queued','running')
), extra as (
  update public.agent_runs set status = 'canceled', cancel_requested = true, error = 'Replaced by a newer run', finished_at = now(), updated_at = now()
  where id in (select id from ranked where position > 1) returning id
)
update public.agent_tasks set status = 'canceled', finished_at = now()
where run_id in (select id from extra) and status in ('pending','running');

create unique index agent_runs_one_active on public.agent_runs(workspace_id) where status in ('queued','running');
