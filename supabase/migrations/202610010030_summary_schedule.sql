create table public.summary_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  job_id uuid not null references public.background_jobs(id),
  period_start date not null,
  cadence text not null check(cadence in ('weekly','monthly')),
  created_at timestamptz not null default now(),
  unique(workspace_id,cadence,period_start)
);
alter table public.summary_runs enable row level security;
create policy own_summary_runs on public.summary_runs for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.summary_runs from public,anon,authenticated;
grant select on public.summary_runs to authenticated;
grant all on public.summary_runs to service_role;
grant select on public.workspace_settings to service_role;
grant select,update on public.background_jobs to service_role;

create function public.claim_scheduled_summary(p_workspace_id uuid,p_cadence text,p_period_start date)
returns uuid language plpgsql security definer set search_path='' as $$
declare preferences public.workspace_settings%rowtype; local_now timestamp; period date; job uuid;
begin
  -- The caller's service-role privilege is the authorization boundary; no authenticated grant.
  select * into preferences from public.workspace_settings where workspace_id=p_workspace_id for update;
  if not found or preferences.summary_cadence='none' or preferences.summary_cadence is distinct from p_cadence
    or not preferences.ai_data_scopes @> array['accounts','transactions']::text[] then return null; end if;
  local_now := now() at time zone preferences.timezone;
  period := date_trunc(case p_cadence when 'weekly' then 'week' else 'month' end,local_now)::date;
  if period is distinct from p_period_start or (local_now::date=period and local_now::time<preferences.summary_time::time) then return null; end if;
  if exists(select 1 from public.summary_runs where workspace_id=p_workspace_id and cadence=p_cadence and period_start=period) then return null; end if;
  insert into public.background_jobs(workspace_id,kind,stage) values(p_workspace_id,'financial_review','scheduled') returning id into job;
  insert into public.summary_runs(workspace_id,job_id,period_start,cadence) values(p_workspace_id,job,period,p_cadence);
  return job;
end;
$$;
revoke all on function public.claim_scheduled_summary(uuid,text,date) from public,anon,authenticated;
grant execute on function public.claim_scheduled_summary(uuid,text,date) to service_role;
