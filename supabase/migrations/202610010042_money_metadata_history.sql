alter table public.accounts add column version integer not null default 1;
alter table public.accounts add column archived_at timestamptz;
alter table public.transaction_views add column version integer not null default 1;
alter table public.transaction_views add column removed_at timestamptz;
create table public.money_metadata_events (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  entity_type text not null check(entity_type in ('account','transaction_view')), entity_id uuid not null,
  actor_id uuid not null references auth.users(id), before jsonb not null, after jsonb not null, input jsonb not null,
  request_id uuid not null, undo_of uuid references public.money_metadata_events(id), created_at timestamptz not null default now(),
  undone_at timestamptz, undone_by uuid references auth.users(id), unique(workspace_id,request_id)
);
alter table public.money_metadata_events enable row level security;
create policy money_metadata_events_owner_select on public.money_metadata_events for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.money_metadata_events from public,anon,authenticated;
grant select on public.money_metadata_events to authenticated;
revoke update,delete on public.accounts,public.transaction_views from authenticated;

create function public.guard_account_metadata() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.workspace_id<>old.workspace_id or new.currency_code<>old.currency_code then raise exception 'Account workspace and currency are immutable' using errcode='22023'; end if;
  if (new.archived_at is not null and old.archived_at is null) or (new.type not in ('checking','savings','cash','wallet') and old.type in ('checking','savings','cash','wallet')) then
    if exists(select 1 from public.goal_allocations where account_id=old.id and amount_minor>0) then raise exception 'Release goal reservations before archiving or changing liquidity' using errcode='22023'; end if;
  end if;
  if new.archived_at is not null and old.archived_at is null and exists(select 1 from public.transactions where account_id=old.id and status='pending' and amount_minor<0) then
    raise exception 'Resolve pending debits before archiving this account' using errcode='22023'; end if;
  return new;
end;
$$;
revoke all on function public.guard_account_metadata() from public,anon,authenticated;
create trigger accounts_metadata_guard before update on public.accounts for each row execute function public.guard_account_metadata();

create function public.guard_active_transaction_account() returns trigger language plpgsql security definer set search_path='' as $$
declare account public.accounts%rowtype;
begin
  select * into account from public.accounts where id=new.account_id for share;
  if account.workspace_id is distinct from new.workspace_id or account.archived_at is not null then raise exception 'An active owned account is required for a new transaction' using errcode='22023'; end if;
  return new;
end;
$$;
revoke all on function public.guard_active_transaction_account() from public,anon,authenticated;
create trigger transaction_active_account_insert before insert on public.transactions for each row execute function public.guard_active_transaction_account();
create trigger transaction_active_account_move before update of account_id on public.transactions for each row when(old.account_id is distinct from new.account_id) execute function public.guard_active_transaction_account();

create function public.guard_active_reservation_account() returns trigger language plpgsql security definer set search_path='' as $$
declare archived timestamptz;
begin
  if tg_op='INSERT' or new.amount_minor>old.amount_minor or new.account_id<>old.account_id then
    select archived_at into archived from public.accounts where id=new.account_id for update;
    if archived is not null and new.amount_minor>0 then raise exception 'Archived account cannot fund a reservation' using errcode='22023'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_active_reservation_account() from public,anon,authenticated;
create trigger goal_reservation_active_account before insert or update on public.goal_allocations for each row execute function public.guard_active_reservation_account();

create function public.edit_money_metadata(p_entity_type text,p_id uuid,p_expected_version integer,p_patch jsonb,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare current_row jsonb; next_row jsonb; workspace uuid; prior public.money_metadata_events%rowtype; event uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_entity_type is null or p_entity_type not in ('account','transaction_view') or p_id is null or p_expected_version is null or p_expected_version<1 or p_expected_version>=2147483647
    or p_request_id is null or p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}' then raise exception 'Invalid metadata edit' using errcode='22023'; end if;
  if p_entity_type='account' then
    if p_patch-array['name','type','archived']<>'{}' then raise exception 'Unsupported account fields' using errcode='22023'; end if;
    select to_jsonb(a) into current_row from public.accounts a where id=p_id and public.owns_workspace(workspace_id) for update;
  else
    if p_patch-array['name','filters','removed']<>'{}' then raise exception 'Unsupported view fields' using errcode='22023'; end if;
    select to_jsonb(v) into current_row from public.transaction_views v where id=p_id and public.owns_workspace(workspace_id) for update;
  end if;
  if current_row is null then raise exception 'Metadata record not found' using errcode='P0002'; end if;
  workspace:=(current_row->>'workspace_id')::uuid;
  select * into prior from public.money_metadata_events where workspace_id=workspace and request_id=p_request_id;
  if found then
    if prior.entity_type<>p_entity_type or prior.entity_id<>p_id or prior.input<>p_patch or prior.before->>'version'<>p_expected_version::text or prior.undo_of is not null then raise exception 'Conflicting request identity' using errcode='22023'; end if;
    return prior.id;
  end if;
  if current_row->>'version'<>p_expected_version::text then raise exception 'Metadata changed; reload first' using errcode='40001'; end if;
  if p_patch ? 'name' and (jsonb_typeof(p_patch->'name')<>'string' or length(btrim(p_patch->>'name')) not between 1 and (case p_entity_type when 'account' then 120 else 80 end)) then raise exception 'Invalid name' using errcode='22023'; end if;
  if p_patch ? 'type' and (jsonb_typeof(p_patch->'type')<>'string' or p_patch->>'type' not in ('checking','savings','cash','credit','investment','wallet','other')) then raise exception 'Invalid account type' using errcode='22023'; end if;
  if p_patch ? 'archived' and jsonb_typeof(p_patch->'archived')<>'boolean' or p_patch ? 'removed' and jsonb_typeof(p_patch->'removed')<>'boolean' then raise exception 'Invalid removal flag' using errcode='22023'; end if;
  if p_patch ? 'filters' and (jsonb_typeof(p_patch->'filters')<>'object' or octet_length((p_patch->'filters')::text)>16384) then raise exception 'Invalid view filters' using errcode='22023'; end if;
  if p_entity_type='account' then
    update public.accounts set name=case when p_patch ? 'name' then btrim(p_patch->>'name') else name end,type=coalesce(p_patch->>'type',type),
      archived_at=case when not p_patch ? 'archived' then archived_at when (p_patch->>'archived')::boolean then coalesce(archived_at,now()) else null end,version=version+1 where id=p_id returning to_jsonb(accounts.*) into next_row;
  else
    update public.transaction_views set name=case when p_patch ? 'name' then btrim(p_patch->>'name') else name end,filters=coalesce(p_patch->'filters',filters),
      removed_at=case when not p_patch ? 'removed' then removed_at when (p_patch->>'removed')::boolean then coalesce(removed_at,now()) else null end,version=version+1 where id=p_id returning to_jsonb(transaction_views.*) into next_row;
  end if;
  insert into public.money_metadata_events(workspace_id,entity_type,entity_id,actor_id,before,after,input,request_id)
    values(workspace,p_entity_type,p_id,auth.uid(),current_row,next_row,p_patch,p_request_id) returning id into event;
  return event;
end;
$$;
revoke all on function public.edit_money_metadata(text,uuid,integer,jsonb,uuid) from public,anon;
grant execute on function public.edit_money_metadata(text,uuid,integer,jsonb,uuid) to authenticated;

create function public.undo_money_metadata(p_event_id uuid,p_expected_version integer,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare original public.money_metadata_events%rowtype; prior public.money_metadata_events%rowtype; event uuid; patch jsonb; current_row jsonb; expected_row jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_event_id is null or p_request_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'Invalid metadata undo' using errcode='22023'; end if;
  select * into original from public.money_metadata_events where id=p_event_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Metadata event not found' using errcode='P0002'; end if;
  if original.entity_type='account' then
    select to_jsonb(a) into current_row from public.accounts a where id=original.entity_id and public.owns_workspace(workspace_id) for update;
  else
    select to_jsonb(v) into current_row from public.transaction_views v where id=original.entity_id and public.owns_workspace(workspace_id) for update;
  end if;
  select * into original from public.money_metadata_events where id=p_event_id for update;
  select * into prior from public.money_metadata_events where workspace_id=original.workspace_id and request_id=p_request_id;
  if found then
    if prior.undo_of is distinct from original.id or prior.before->>'version'<>p_expected_version::text then raise exception 'Conflicting undo request' using errcode='22023'; end if;
    return prior.id;
  end if;
  if original.undone_at is not null or original.undo_of is not null then raise exception 'Event cannot be undone' using errcode='22023'; end if;
  if current_row is null or current_row->>'version'<>p_expected_version::text then raise exception 'Metadata changed; reload first' using errcode='40001'; end if;
  expected_row:=original.after;
  current_row:=current_row-array['version','created_at']; expected_row:=expected_row-array['version','created_at'];
  if original.entity_type='account' then
    current_row:=jsonb_set(current_row,'{archived_at}',to_jsonb(current_row->>'archived_at' is not null));
    expected_row:=jsonb_set(expected_row,'{archived_at}',to_jsonb(expected_row->>'archived_at' is not null));
  else
    current_row:=jsonb_set(current_row,'{removed_at}',to_jsonb(current_row->>'removed_at' is not null));
    expected_row:=jsonb_set(expected_row,'{removed_at}',to_jsonb(expected_row->>'removed_at' is not null));
  end if;
  if current_row<>expected_row or exists(select 1 from public.money_metadata_events e where e.workspace_id=original.workspace_id and e.entity_type=original.entity_type and e.entity_id=original.entity_id
    and e.id<>original.id and e.undo_of is null and e.undone_at is null and (e.after->>'version')::integer>(original.after->>'version')::integer) then raise exception 'Undo newer edits first' using errcode='40001'; end if;
  patch:=jsonb_build_object('name',original.before->>'name');
  if original.entity_type='account' then patch:=patch||jsonb_build_object('type',original.before->>'type','archived',original.before->>'archived_at' is not null);
  else patch:=patch||jsonb_build_object('filters',original.before->'filters','removed',original.before->>'removed_at' is not null); end if;
  event:=public.edit_money_metadata(original.entity_type,original.entity_id,p_expected_version,patch,p_request_id);
  update public.money_metadata_events set undo_of=original.id where id=event;
  update public.money_metadata_events set undone_at=now(),undone_by=auth.uid() where id=original.id;
  return event;
end;
$$;
revoke all on function public.undo_money_metadata(uuid,integer,uuid) from public,anon;
grant execute on function public.undo_money_metadata(uuid,integer,uuid) to authenticated;
