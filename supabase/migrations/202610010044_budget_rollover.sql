alter table public.spending_plans add column rollover boolean not null default false;
alter table public.spending_plans add column rollover_from date not null default date_trunc('month',now() at time zone 'Europe/Berlin')::date check(extract(day from rollover_from)=1);
-- Immutable target history is financial evidence, including restoration writes.
-- plan_id is a historical identifier, as with planning_events.entity_id; creation undo can delete the plan while preserving evidence.
create table public.spending_plan_limits (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id), plan_id uuid not null,
 limit_minor bigint not null check(limit_minor>0), enabled boolean not null, version integer not null check(version>0),
 effective_month date not null check(extract(day from effective_month)=1), created_at timestamptz not null default now(),
 unique(workspace_id,plan_id,version)
);
alter table public.spending_plan_limits enable row level security;
create policy spending_plan_limits_owner_select on public.spending_plan_limits for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.spending_plan_limits from public,anon,authenticated;
grant select on public.spending_plan_limits to authenticated;
insert into public.spending_plan_limits(workspace_id,plan_id,limit_minor,enabled,version,effective_month)
select workspace_id,id,limit_minor,enabled,version,date_trunc('month',now() at time zone coalesce((select timezone from public.workspace_settings where workspace_id=spending_plans.workspace_id),'Europe/Berlin'))::date from public.spending_plans;
create function public.record_spending_plan_limit() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.spending_plan_limits(workspace_id,plan_id,limit_minor,enabled,version,effective_month)
 values(new.workspace_id,new.id,new.limit_minor,new.enabled,new.version,date_trunc('month',now() at time zone coalesce((select timezone from public.workspace_settings where workspace_id=new.workspace_id),'Europe/Berlin'))::date);
 return new;
end $$;
revoke all on function public.record_spending_plan_limit() from public,anon,authenticated;
create trigger spending_plan_limit_evidence after insert or update on public.spending_plans for each row execute function public.record_spending_plan_limit();

create or replace function public.edit_spending_plan(p_id uuid, p_expected_version integer, p_patch jsonb, p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  row_value public.spending_plans%rowtype;
  edited public.spending_plans%rowtype;
  existing public.planning_events%rowtype;
  event_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_expected_version is null or p_expected_version < 1 or p_request_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object'
    or p_patch = '{}'::jsonb or p_patch - array['limit_minor','enabled','rollover','rollover_from'] <> '{}'::jsonb
    then raise exception 'Invalid spending plan edit' using errcode = '22023'; end if;
  select * into row_value from public.spending_plans where id = p_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Spending plan not found' using errcode = 'P0002'; end if;
  select * into existing from public.planning_events where workspace_id = row_value.workspace_id and request_id = p_request_id;
  if found then
    if existing.entity_type <> 'spending_plan' or existing.entity_id <> p_id or (existing.before->>'version')::integer <> p_expected_version or not existing.after @> p_patch
      then raise exception 'Request ID reused for a different edit' using errcode = '22023'; end if;
    return existing.id;
  end if;
  if row_value.version <> p_expected_version then raise exception 'Spending plan changed; reload before editing' using errcode = '40001'; end if;
  if p_patch ? 'limit_minor' and (jsonb_typeof(p_patch->'limit_minor') <> 'string' or p_patch->>'limit_minor' !~ '^[0-9]+$')
    then raise exception 'Limit must be an exact integer string' using errcode = '22023'; end if;
  if p_patch ? 'enabled' and jsonb_typeof(p_patch->'enabled') <> 'boolean' then raise exception 'Enabled must be boolean' using errcode = '22023'; end if;
  if p_patch ? 'rollover' and jsonb_typeof(p_patch->'rollover') <> 'boolean' then raise exception 'Rollover must be boolean' using errcode='22023'; end if;
  if p_patch ? 'rollover_from' and (jsonb_typeof(p_patch->'rollover_from') <> 'string' or p_patch->>'rollover_from' !~ '^\d{4}-\d{2}-01$') then raise exception 'Rollover begins on a calendar month' using errcode='22023'; end if;
  edited := jsonb_populate_record(row_value, p_patch);
  perform set_config('moneo.planning_request_id', p_request_id::text, true);
  update public.spending_plans set limit_minor = edited.limit_minor, enabled = edited.enabled, rollover = edited.rollover, rollover_from = edited.rollover_from, updated_at = now() where id = p_id;
  perform set_config('moneo.planning_request_id', '', true);
  select id into strict event_id from public.planning_events where workspace_id = row_value.workspace_id and request_id = p_request_id;
  return event_id;
end;
$$;

create or replace function public.undo_planning_event(p_event_id uuid, p_expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  event_row public.planning_events%rowtype;
  current_value jsonb;
  assumption public.financial_assumptions%rowtype;
  spending public.spending_plans%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into event_row from public.planning_events where id = p_event_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Planning event not found' using errcode = 'P0002'; end if;
  if event_row.entity_type = 'assumption' then
    select * into assumption from public.financial_assumptions where id = event_row.entity_id and workspace_id = event_row.workspace_id for update;
    current_value := to_jsonb(assumption) || jsonb_build_object('amount_minor', assumption.amount_minor::text);
  else
    select * into spending from public.spending_plans where id = event_row.entity_id and workspace_id = event_row.workspace_id for update;
    current_value := to_jsonb(spending) || jsonb_build_object('limit_minor', spending.limit_minor::text);
    if not event_row.after ? 'rollover' then current_value:=current_value-array['rollover','rollover_from']; end if;
  end if;
  select * into event_row from public.planning_events where id = p_event_id for update;
  if event_row.undone then return; end if;
  if p_expected_version is null or (current_value->>'version')::integer is distinct from p_expected_version
    or current_value - array['version','updated_at'] is distinct from event_row.after - array['version','updated_at']
    then raise exception 'Planning record changed; undo latest change first' using errcode = '40001'; end if;
  if exists(select 1 from public.planning_events where workspace_id=event_row.workspace_id and entity_type=event_row.entity_type and entity_id=event_row.entity_id and not undone and (after->>'version')::integer>(event_row.after->>'version')::integer) then raise exception 'Undo newer planning changes first' using errcode='40001'; end if;
  perform set_config('moneo.planning_undo', 'true', true);
  if event_row.entity_type = 'assumption' then
    if event_row.before is null then
      update public.financial_assumptions set enabled = false, removed_at = now(), source = 'user', confirmed = true where id = event_row.entity_id;
    else
      assumption := jsonb_populate_record(null::public.financial_assumptions, event_row.before);
      update public.financial_assumptions set name = assumption.name, amount_minor = assumption.amount_minor, kind = assumption.kind,
        cadence = assumption.cadence, starts_on = assumption.starts_on, ends_on = assumption.ends_on,
        source = assumption.source, confidence = assumption.confidence, confirmed = assumption.confirmed,
        enabled = assumption.enabled, removed_at = assumption.removed_at where id = event_row.entity_id;
    end if;
  else
    if event_row.before is null then
      delete from public.spending_plans where id = event_row.entity_id;
    else
      spending := jsonb_populate_record(null::public.spending_plans, event_row.before);
      update public.spending_plans set limit_minor = spending.limit_minor, enabled = spending.enabled, rollover = coalesce(spending.rollover,false), rollover_from = coalesce(spending.rollover_from,(select rollover_from from public.spending_plans where id=event_row.entity_id)), updated_at = now() where id = event_row.entity_id;
    end if;
  end if;
  update public.planning_events set undone = true, undone_at = now(), undone_by = auth.uid() where id = p_event_id;
  perform set_config('moneo.planning_undo', 'false', true);
end;
$$;

