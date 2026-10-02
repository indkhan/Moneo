alter table public.scenarios add column version integer not null default 1;
alter table public.scenarios add column removed_at timestamptz;
alter table public.scenario_overrides add column version integer not null default 1;
alter table public.scenario_overrides add column removed_at timestamptz;
create table public.scenario_events (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 entity_type text not null check(entity_type in ('scenario','override')), entity_id uuid not null,
 actor_id uuid references auth.users(id), before jsonb, after jsonb not null, request_id uuid,
 created_at timestamptz not null default now(), undone boolean not null default false,
 undone_at timestamptz, undone_by uuid references auth.users(id), unique(workspace_id,request_id)
);
alter table public.scenario_events enable row level security;
create policy scenario_events_owner_select on public.scenario_events for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.scenario_events from public,anon,authenticated;
grant select on public.scenario_events to authenticated;
revoke update,delete on public.scenarios,public.scenario_overrides from authenticated;
create function public.guard_scenario_scope() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.scenarios where id=new.scenario_id and workspace_id=new.workspace_id)
  or not exists(select 1 from public.accounts where id=new.account_id and workspace_id=new.workspace_id and currency_code=new.currency_code)
  or (new.assumption_id is not null and not exists(select 1 from public.financial_assumptions where id=new.assumption_id and workspace_id=new.workspace_id and (account_id is null or account_id=new.account_id))) then raise exception 'Scenario relationships must belong to the workspace and account currency' using errcode='22023'; end if;
 return new;
end $$;
revoke all on function public.guard_scenario_scope() from public,anon,authenticated;
create trigger scenario_scope_guard before insert or update on public.scenario_overrides for each row execute function public.guard_scenario_scope();
create function public.audit_scenario_record() returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb; snapshot jsonb;
begin
 if tg_when='BEFORE' then new.version:=old.version+1; return new; end if;
 if current_setting('moneo.scenario_undo',true)='true' then return new; end if;
 if tg_op='UPDATE' then previous:=to_jsonb(old); end if;
 snapshot:=to_jsonb(new);
 if tg_table_name='scenario_overrides' then
  snapshot:=snapshot||jsonb_build_object('amount_delta_minor',new.amount_delta_minor::text);
  if previous is not null then previous:=previous||jsonb_build_object('amount_delta_minor',old.amount_delta_minor::text); end if;
 end if;
 insert into public.scenario_events(workspace_id,entity_type,entity_id,actor_id,before,after,request_id)
 values(new.workspace_id,case tg_table_name when 'scenarios' then 'scenario' else 'override' end,new.id,auth.uid(),previous,snapshot,nullif(current_setting('moneo.scenario_request',true),'')::uuid);
 return new;
end $$;
revoke all on function public.audit_scenario_record() from public,anon,authenticated;
create trigger scenario_version before update on public.scenarios for each row execute function public.audit_scenario_record();
create trigger scenario_history after insert or update on public.scenarios for each row execute function public.audit_scenario_record();
create trigger scenario_override_version before update on public.scenario_overrides for each row execute function public.audit_scenario_record();
create trigger scenario_override_history after insert or update on public.scenario_overrides for each row execute function public.audit_scenario_record();

create function public.edit_scenario_record(p_entity_type text,p_id uuid,p_expected_version integer,p_patch jsonb,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare snapshot jsonb; workspace uuid; previous public.scenario_events%rowtype; scenario public.scenarios%rowtype; event public.scenario_overrides%rowtype; event_id uuid;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
 if p_id is null or p_entity_type is null or p_entity_type not in ('scenario','override') or p_expected_version is null or p_expected_version<1 or p_expected_version>=2147483647 or p_request_id is null or jsonb_typeof(p_patch) is distinct from 'object' or p_patch='{}' then raise exception 'Invalid scenario edit' using errcode='22023'; end if;
 if p_patch ? 'name' then
  if jsonb_typeof(p_patch->'name')<>'string' or length(btrim(p_patch->>'name')) not between 1 and 120 then raise exception 'Invalid scenario name' using errcode='22023'; end if;
  p_patch:=jsonb_set(p_patch,'{name}',to_jsonb(btrim(p_patch->>'name')));
 end if;
 if p_entity_type='scenario' then
  if p_patch-array['name','description','removed']<>'{}' then raise exception 'Unsupported scenario fields' using errcode='22023'; end if;
  select * into scenario from public.scenarios where id=p_id and public.owns_workspace(workspace_id) for update;
  snapshot:=case when found then to_jsonb(scenario) end;
 else
  if p_patch-array['name','amount_delta_minor','cadence','starts_on','ends_on','removed']<>'{}' then raise exception 'Unsupported event fields' using errcode='22023'; end if;
  select * into event from public.scenario_overrides where id=p_id and public.owns_workspace(workspace_id) for update;
  snapshot:=case when found then to_jsonb(event)||jsonb_build_object('amount_delta_minor',event.amount_delta_minor::text) end;
 end if;
 if snapshot is null then raise exception 'Scenario record unavailable' using errcode='P0002'; end if;
 workspace:=(snapshot->>'workspace_id')::uuid;
 select * into previous from public.scenario_events where workspace_id=workspace and request_id=p_request_id;
 if found then
  if previous.entity_type<>p_entity_type or previous.entity_id<>p_id or (previous.before->>'version')::integer<>p_expected_version or not previous.after @> (p_patch-'removed') or (p_patch ? 'removed' and previous.after->>'removed_at' is null) then raise exception 'Request reused for another edit' using errcode='22023'; end if;
  return previous.id;
 end if;
 if (snapshot->>'version')::integer<>p_expected_version then raise exception 'Scenario changed; refresh before editing' using errcode='40001'; end if;
 if snapshot->>'removed_at' is not null then raise exception 'Restore removed records before editing' using errcode='22023'; end if;
 if p_patch ? 'removed' and p_patch<>'{"removed":true}' then raise exception 'Invalid scenario removal' using errcode='22023'; end if;
 if p_patch ? 'description' and p_patch->'description'<>'null' and (jsonb_typeof(p_patch->'description')<>'string' or length(p_patch->>'description')>1000) then raise exception 'Invalid scenario description' using errcode='22023'; end if;
 if p_patch ? 'amount_delta_minor' and (jsonb_typeof(p_patch->'amount_delta_minor')<>'string' or p_patch->>'amount_delta_minor' !~ '^-?[0-9]{1,19}$') then raise exception 'Exact scenario money required' using errcode='22023'; end if;
 if p_patch ? 'starts_on' and (jsonb_typeof(p_patch->'starts_on')<>'string' or p_patch->>'starts_on' !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'Use an explicit start date' using errcode='22023'; end if;
 if p_patch ? 'ends_on' and p_patch->'ends_on'<>'null' and (jsonb_typeof(p_patch->'ends_on')<>'string' or p_patch->>'ends_on' !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'Use an explicit end date' using errcode='22023'; end if;
 perform set_config('moneo.scenario_request',p_request_id::text,true);
 if p_entity_type='scenario' then
  scenario:=jsonb_populate_record(scenario,p_patch-'removed');
  update public.scenarios set name=btrim(scenario.name),description=scenario.description,removed_at=case when p_patch ? 'removed' then now() else null end where id=p_id;
 else
  event:=jsonb_populate_record(event,p_patch-'removed');
  update public.scenario_overrides set name=btrim(event.name),amount_delta_minor=event.amount_delta_minor,cadence=event.cadence,starts_on=event.starts_on,ends_on=event.ends_on,removed_at=case when p_patch ? 'removed' then now() else null end where id=p_id;
 end if;
 perform set_config('moneo.scenario_request','',true);
 select id into strict event_id from public.scenario_events where workspace_id=workspace and request_id=p_request_id;
 return event_id;
end $$;
create function public.undo_scenario_record(p_event_id uuid,p_expected_version integer) returns void language plpgsql security definer set search_path='' as $$
declare change public.scenario_events%rowtype; scenario public.scenarios%rowtype; event public.scenario_overrides%rowtype; snapshot jsonb;
begin
 select * into change from public.scenario_events where id=p_event_id and public.owns_workspace(workspace_id);
 if not found then raise exception 'Scenario event unavailable' using errcode='P0002'; end if;
 if change.entity_type='scenario' then
  select * into scenario from public.scenarios where id=change.entity_id and workspace_id=change.workspace_id for update;
  snapshot:=to_jsonb(scenario);
 else
  select * into event from public.scenario_overrides where id=change.entity_id and workspace_id=change.workspace_id for update;
  snapshot:=to_jsonb(event)||jsonb_build_object('amount_delta_minor',event.amount_delta_minor::text);
 end if;
 select * into change from public.scenario_events where id=p_event_id for update;
 if change.undone then return; end if;
 if p_expected_version is null or (snapshot->>'version')::integer is distinct from p_expected_version or snapshot-'version' is distinct from change.after-'version' or exists(select 1 from public.scenario_events where entity_type=change.entity_type and entity_id=change.entity_id and workspace_id=change.workspace_id and not undone and (after->>'version')::integer>(change.after->>'version')::integer) then raise exception 'Scenario changed; undo newer changes first' using errcode='40001'; end if;
 perform set_config('moneo.scenario_undo','true',true);
 if change.entity_type='scenario' then
  if change.before is null then update public.scenarios set removed_at=now() where id=change.entity_id;
  else
   scenario:=jsonb_populate_record(scenario,change.before);
   update public.scenarios set name=scenario.name,description=scenario.description,removed_at=scenario.removed_at where id=change.entity_id;
  end if;
 else
  if change.before is null then update public.scenario_overrides set removed_at=now() where id=change.entity_id;
  else
   event:=jsonb_populate_record(event,change.before);
   update public.scenario_overrides set name=event.name,amount_delta_minor=event.amount_delta_minor,cadence=event.cadence,starts_on=event.starts_on,ends_on=event.ends_on,removed_at=event.removed_at where id=change.entity_id;
  end if;
 end if;
 update public.scenario_events set undone=true,undone_at=now(),undone_by=auth.uid() where id=change.id;
 perform set_config('moneo.scenario_undo','false',true);
end $$;
revoke all on function public.edit_scenario_record(text,uuid,integer,jsonb,uuid),public.undo_scenario_record(uuid,integer) from public,anon;
grant execute on function public.edit_scenario_record(text,uuid,integer,jsonb,uuid),public.undo_scenario_record(uuid,integer) to authenticated;
