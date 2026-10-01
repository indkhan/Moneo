alter table public.goals add column planned_monthly_minor bigint not null default 0 check(planned_monthly_minor>=0);
alter table public.goals add column contribution_starts_on date;
alter table public.goals add column recorded_saved_minor bigint check(recorded_saved_minor>=0);
alter table public.goals add column saved_as_of date;
alter table public.goals add constraint goals_saved_evidence_check check((recorded_saved_minor is null)=(saved_as_of is null));
alter table public.goals add constraint goals_contribution_date_check check(planned_monthly_minor=0 or contribution_starts_on is not null);
create table public.goal_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  goal_id uuid not null references public.goals(id),
  actor_id uuid references auth.users(id),
  before jsonb, after jsonb not null, request_id uuid,
  created_at timestamptz not null default now(),
  undone boolean not null default false, undone_at timestamptz, undone_by uuid references auth.users(id),
  unique(workspace_id,request_id)
);
alter table public.goal_events enable row level security;
create policy own_goal_events on public.goal_events for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.goal_events from public,anon,authenticated;
grant select on public.goal_events to authenticated;
create function public.audit_goal_plan() returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb; current_value jsonb;
begin
  if tg_when='BEFORE' then new.version:=old.version+1; return new; end if;
  if current_setting('moneo.goal_undo',true)='true' then return new; end if;
  if tg_op='UPDATE' then previous:=to_jsonb(old)||jsonb_build_object('target_minor',old.target_minor::text,'planned_monthly_minor',old.planned_monthly_minor::text,'recorded_saved_minor',old.recorded_saved_minor::text); end if;
  current_value:=to_jsonb(new)||jsonb_build_object('target_minor',new.target_minor::text,'planned_monthly_minor',new.planned_monthly_minor::text,'recorded_saved_minor',new.recorded_saved_minor::text);
  insert into public.goal_events(workspace_id,goal_id,actor_id,before,after,request_id) values(new.workspace_id,new.id,auth.uid(),previous,current_value,nullif(current_setting('moneo.goal_request',true),'')::uuid);
  return new;
end;
$$;
revoke all on function public.audit_goal_plan() from public;
create trigger goal_plan_version before update on public.goals for each row execute function public.audit_goal_plan();
create trigger goal_plan_audit after insert or update on public.goals for each row execute function public.audit_goal_plan();
create function public.edit_goal_plan(p_goal_id uuid,p_expected_version integer,p_patch jsonb,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare current_goal public.goals%rowtype; edited public.goals%rowtype; previous_event public.goal_events%rowtype; event_id uuid; money_key text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_expected_version is null or p_expected_version<0 or p_request_id is null or p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb
    or p_patch-array['name','target_minor','target_date','priority','status','notes','planned_monthly_minor','contribution_starts_on','recorded_saved_minor','saved_as_of']<>'{}'::jsonb then raise exception 'Invalid goal edit' using errcode='22023'; end if;
  select * into current_goal from public.goals where id=p_goal_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Goal unavailable' using errcode='P0002'; end if;
  select * into previous_event from public.goal_events where workspace_id=current_goal.workspace_id and request_id=p_request_id;
  if found then
    if previous_event.goal_id<>p_goal_id or (previous_event.before->>'version')::integer is distinct from p_expected_version or not previous_event.after @> p_patch then raise exception 'Request ID reused for another goal edit' using errcode='22023'; end if;
    return previous_event.id;
  end if;
  if current_goal.version<>p_expected_version then raise exception 'Goal changed; reload before editing' using errcode='40001'; end if;
  foreach money_key in array array['target_minor','planned_monthly_minor','recorded_saved_minor'] loop
    if p_patch ? money_key and p_patch->money_key<>'null'::jsonb and (jsonb_typeof(p_patch->money_key)<>'string' or p_patch->>money_key !~ '^[0-9]+$') then raise exception 'Goal amounts must be exact nonnegative integer strings' using errcode='22023'; end if;
  end loop;
  edited:=jsonb_populate_record(current_goal,p_patch);
  if edited.name is null or length(btrim(edited.name)) not between 1 and 120 or edited.priority not between 0 and 100
    or edited.status not in ('active','paused','completed','archived') or length(coalesce(edited.notes,''))>1000
    or edited.target_minor is null or edited.planned_monthly_minor is null then raise exception 'Invalid goal values' using errcode='22023'; end if;
  if edited.saved_as_of>(now() at time zone coalesce((select timezone from public.workspace_settings where workspace_id=current_goal.workspace_id),'Europe/Berlin'))::date then raise exception 'Recorded savings date cannot be in the future' using errcode='22023'; end if;
  perform set_config('moneo.goal_request',p_request_id::text,true);
  update public.goals set name=edited.name,target_minor=edited.target_minor,target_date=edited.target_date,priority=edited.priority,status=edited.status,notes=edited.notes,
    planned_monthly_minor=edited.planned_monthly_minor,contribution_starts_on=edited.contribution_starts_on,recorded_saved_minor=edited.recorded_saved_minor,saved_as_of=edited.saved_as_of where id=p_goal_id;
  perform set_config('moneo.goal_request','',true);
  select id into strict event_id from public.goal_events where workspace_id=current_goal.workspace_id and request_id=p_request_id;
  return event_id;
end;
$$;
create function public.undo_goal_plan(p_event_id uuid,p_expected_version integer) returns void language plpgsql security definer set search_path='' as $$
declare event_row public.goal_events%rowtype; current_goal public.goals%rowtype; restored public.goals%rowtype; current_value jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into event_row from public.goal_events where id=p_event_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Goal history unavailable' using errcode='P0002'; end if;
  select * into current_goal from public.goals where id=event_row.goal_id and workspace_id=event_row.workspace_id for update;
  select * into event_row from public.goal_events where id=p_event_id for update;
  if event_row.undone then return; end if;
  current_value:=to_jsonb(current_goal)||jsonb_build_object('target_minor',current_goal.target_minor::text,'planned_monthly_minor',current_goal.planned_monthly_minor::text,'recorded_saved_minor',current_goal.recorded_saved_minor::text);
  if p_expected_version is null or current_goal.version is distinct from p_expected_version or current_value-'version' is distinct from event_row.after-'version' then raise exception 'Goal changed; undo newer edits first' using errcode='40001'; end if;
  restored:=jsonb_populate_record(current_goal,coalesce(event_row.before,'{"status":"archived"}'::jsonb));
  perform set_config('moneo.goal_undo','true',true);
  update public.goals set name=restored.name,target_minor=restored.target_minor,target_date=restored.target_date,priority=restored.priority,status=restored.status,notes=restored.notes,
    planned_monthly_minor=restored.planned_monthly_minor,contribution_starts_on=restored.contribution_starts_on,recorded_saved_minor=restored.recorded_saved_minor,saved_as_of=restored.saved_as_of where id=current_goal.id;
  update public.goal_events set undone=true,undone_at=now(),undone_by=auth.uid() where id=p_event_id;
  perform set_config('moneo.goal_undo','false',true);
end;
$$;
revoke update,delete on public.goals from authenticated;
revoke all on function public.edit_goal_plan(uuid,integer,jsonb,uuid),public.undo_goal_plan(uuid,integer) from public;
grant execute on function public.edit_goal_plan(uuid,integer,jsonb,uuid),public.undo_goal_plan(uuid,integer) to authenticated;
