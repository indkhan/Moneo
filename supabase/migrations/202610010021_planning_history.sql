-- Planning mutations retain sources, serialize edits, and can be undone.
alter table public.financial_assumptions add column version integer not null default 1;
alter table public.financial_assumptions add column removed_at timestamptz;
alter table public.spending_plans add column version integer not null default 1;

create table public.planning_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  entity_type text not null check (entity_type in ('assumption', 'spending_plan')),
  entity_id uuid not null,
  actor_id uuid references auth.users(id),
  before jsonb,
  after jsonb,
  request_id uuid,
  created_at timestamptz not null default now(),
  undone boolean not null default false,
  undone_at timestamptz,
  undone_by uuid references auth.users(id),
  unique(workspace_id, request_id)
);
create index planning_events_entity_idx on public.planning_events(workspace_id, entity_type, entity_id, created_at);
alter table public.planning_events enable row level security;
create policy own_planning_events on public.planning_events for select to authenticated using (public.owns_workspace(workspace_id));
grant select on public.planning_events to authenticated;
revoke insert, update, delete on public.planning_events from public, authenticated;

create function public.audit_planning_record() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  previous jsonb;
  current_value jsonb;
  money_key text := case when tg_table_name = 'financial_assumptions' then 'amount_minor' else 'limit_minor' end;
begin
  if tg_when = 'BEFORE' then
    new.version := old.version + 1;
    return new;
  end if;
  if current_setting('moneo.planning_undo', true) = 'true' then return new; end if;
  if tg_op <> 'INSERT' then
    previous := to_jsonb(old);
    previous := jsonb_set(previous, array[money_key], to_jsonb(previous->>money_key));
  end if;
  if tg_op <> 'DELETE' then
    current_value := to_jsonb(new);
    current_value := jsonb_set(current_value, array[money_key], to_jsonb(current_value->>money_key));
  end if;
  insert into public.planning_events(workspace_id, entity_type, entity_id, actor_id, before, after, request_id)
  values(coalesce(new.workspace_id, old.workspace_id), case when tg_table_name = 'financial_assumptions' then 'assumption' else 'spending_plan' end,
    coalesce(new.id, old.id), auth.uid(), previous, current_value,
    nullif(current_setting('moneo.planning_request_id', true), '')::uuid);
  return coalesce(new, old);
end;
$$;
revoke all on function public.audit_planning_record() from public;
create trigger assumption_version before update on public.financial_assumptions for each row execute function public.audit_planning_record();
create trigger assumption_history after insert or update or delete on public.financial_assumptions for each row execute function public.audit_planning_record();
create trigger spending_plan_version before update on public.spending_plans for each row execute function public.audit_planning_record();
create trigger spending_plan_history after insert or update or delete on public.spending_plans for each row execute function public.audit_planning_record();

create function public.edit_assumption(p_id uuid, p_expected_version integer, p_patch jsonb, p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  row_value public.financial_assumptions%rowtype;
  edited public.financial_assumptions%rowtype;
  existing public.planning_events%rowtype;
  event_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_expected_version is null or p_expected_version < 1 or p_request_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object'
    or p_patch = '{}'::jsonb or p_patch - array['name','amount_minor','kind','cadence','starts_on','ends_on','enabled','removed'] <> '{}'::jsonb
    then raise exception 'Invalid assumption edit' using errcode = '22023'; end if;
  if p_patch ? 'name' then
    if jsonb_typeof(p_patch->'name') <> 'string' then raise exception 'Name must be text' using errcode = '22023'; end if;
    p_patch := jsonb_set(p_patch, '{name}', to_jsonb(btrim(p_patch->>'name')));
  end if;
  select * into row_value from public.financial_assumptions where id = p_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Assumption not found' using errcode = 'P0002'; end if;
  select * into existing from public.planning_events where workspace_id = row_value.workspace_id and request_id = p_request_id;
  if found then
    if existing.entity_type <> 'assumption' or existing.entity_id <> p_id or (existing.before->>'version')::integer <> p_expected_version
      or not existing.after @> (p_patch - 'removed') or (p_patch ? 'removed' and existing.after->>'removed_at' is null)
      then raise exception 'Request ID reused for a different edit' using errcode = '22023'; end if;
    return existing.id;
  end if;
  if row_value.version <> p_expected_version then raise exception 'Assumption changed; reload before editing' using errcode = '40001'; end if;
  if row_value.removed_at is not null then raise exception 'Assumption is removed; undo its removal first' using errcode = '22023'; end if;
  if p_patch ? 'removed' and p_patch <> '{"removed":true}'::jsonb then raise exception 'Invalid removal' using errcode = '22023'; end if;
  if p_patch ? 'amount_minor' and (jsonb_typeof(p_patch->'amount_minor') <> 'string' or p_patch->>'amount_minor' !~ '^-?[0-9]+$')
    then raise exception 'Amount must be an exact integer string' using errcode = '22023'; end if;
  if p_patch ? 'enabled' and jsonb_typeof(p_patch->'enabled') <> 'boolean' then raise exception 'Enabled must be boolean' using errcode = '22023'; end if;
  edited := jsonb_populate_record(row_value, p_patch - 'removed');
  if p_patch ? 'kind' and p_patch->>'kind' is distinct from (case when edited.amount_minor >= 0 then 'income' else 'expense' end)
    then raise exception 'Kind must match the signed amount' using errcode = '22023'; end if;
  if p_patch ? 'starts_on' and (jsonb_typeof(p_patch->'starts_on') <> 'string' or p_patch->>'starts_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    then raise exception 'Start date must be an ISO calendar date' using errcode = '22023'; end if;
  if p_patch ? 'ends_on' and p_patch->'ends_on' <> 'null'::jsonb and (jsonb_typeof(p_patch->'ends_on') <> 'string' or p_patch->>'ends_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    then raise exception 'End date must be an ISO calendar date' using errcode = '22023'; end if;
  if edited.name is null or length(btrim(edited.name)) not between 1 and 120 then raise exception 'Invalid assumption name' using errcode = '22023'; end if;
  perform set_config('moneo.planning_request_id', p_request_id::text, true);
  update public.financial_assumptions set name = btrim(edited.name), amount_minor = edited.amount_minor,
    kind = case when edited.amount_minor >= 0 then 'income' else 'expense' end,
    cadence = edited.cadence, starts_on = edited.starts_on, ends_on = edited.ends_on,
    source = 'user', confirmed = true,
    enabled = case when p_patch ? 'removed' then false else edited.enabled end,
    removed_at = case when p_patch ? 'removed' then now() else null end
  where id = p_id;
  perform set_config('moneo.planning_request_id', '', true);
  select id into strict event_id from public.planning_events where workspace_id = row_value.workspace_id and request_id = p_request_id;
  return event_id;
end;
$$;

create function public.edit_spending_plan(p_id uuid, p_expected_version integer, p_patch jsonb, p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  row_value public.spending_plans%rowtype;
  edited public.spending_plans%rowtype;
  existing public.planning_events%rowtype;
  event_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_expected_version is null or p_expected_version < 1 or p_request_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object'
    or p_patch = '{}'::jsonb or p_patch - array['limit_minor','enabled'] <> '{}'::jsonb
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
  edited := jsonb_populate_record(row_value, p_patch);
  perform set_config('moneo.planning_request_id', p_request_id::text, true);
  update public.spending_plans set limit_minor = edited.limit_minor, enabled = edited.enabled, updated_at = now() where id = p_id;
  perform set_config('moneo.planning_request_id', '', true);
  select id into strict event_id from public.planning_events where workspace_id = row_value.workspace_id and request_id = p_request_id;
  return event_id;
end;
$$;

create function public.undo_planning_event(p_event_id uuid, p_expected_version integer)
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
  end if;
  select * into event_row from public.planning_events where id = p_event_id for update;
  if event_row.undone then return; end if;
  if p_expected_version is null or (current_value->>'version')::integer is distinct from p_expected_version
    or current_value - array['version','updated_at'] is distinct from event_row.after - array['version','updated_at']
    then raise exception 'Planning record changed; undo latest change first' using errcode = '40001'; end if;
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
      update public.spending_plans set limit_minor = spending.limit_minor, enabled = spending.enabled, updated_at = now() where id = event_row.entity_id;
    end if;
  end if;
  update public.planning_events set undone = true, undone_at = now(), undone_by = auth.uid() where id = p_event_id;
  perform set_config('moneo.planning_undo', 'false', true);
end;
$$;

revoke update, delete on public.financial_assumptions, public.spending_plans from authenticated;
revoke all on function public.edit_assumption(uuid, integer, jsonb, uuid), public.edit_spending_plan(uuid, integer, jsonb, uuid), public.undo_planning_event(uuid, integer) from public;
grant execute on function public.edit_assumption(uuid, integer, jsonb, uuid), public.edit_spending_plan(uuid, integer, jsonb, uuid), public.undo_planning_event(uuid, integer) to authenticated;
