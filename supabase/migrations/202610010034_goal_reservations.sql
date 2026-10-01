alter table public.goal_allocations add column version integer not null default 1;
alter table public.goal_allocations drop constraint goal_allocations_amount_minor_check;
alter table public.goal_allocations add constraint goal_allocations_amount_minor_check check(amount_minor>=0);
create table public.goal_reservation_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  allocation_id uuid not null references public.goal_allocations(id),
  actor_id uuid not null references auth.users(id),
  before jsonb not null,
  after jsonb not null,
  request_id uuid not null,
  undo_of uuid references public.goal_reservation_events(id),
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id),
  unique(workspace_id,request_id)
);
alter table public.goal_reservation_events enable row level security;
create policy goal_reservation_events_owner_select on public.goal_reservation_events for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.goal_reservation_events from public,anon,authenticated;
grant select on public.goal_reservation_events to authenticated;

-- Private deterministic counterpart to resolveBalances. All money remains exact numeric/text.
create function public.reservation_balance_evidence(p_account_id uuid,p_as_of timestamptz,p_timezone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare account public.accounts%rowtype; snapshot public.balance_snapshots%rowtype; row public.transactions%rowtype;
  today date:=(p_as_of at time zone p_timezone)::date; boundary date; posting date; estimate numeric; holds numeric:=0; status text;
begin
  select * into account from public.accounts where id=p_account_id for update;
  if not found then return jsonb_build_object('status','missing','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor','0'); end if;
  perform id from public.balance_snapshots where account_id=account.id and workspace_id=account.workspace_id order by id for share;
  perform id from public.transactions where account_id=account.id and workspace_id=account.workspace_id order by id for share;
  select * into snapshot from public.balance_snapshots where account_id=account.id and workspace_id=account.workspace_id and as_of<=p_as_of order by as_of desc,id limit 1;
  if not found then return jsonb_build_object('status','missing','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor','0'); end if;
  if snapshot.currency_code<>account.currency_code or exists(select 1 from public.balance_snapshots where account_id=account.id and workspace_id=account.workspace_id and as_of=snapshot.as_of
    and (currency_code<>snapshot.currency_code or amount_minor<>snapshot.amount_minor)) then
    return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor','0'); end if;
  boundary:=(snapshot.as_of at time zone p_timezone)::date;
  estimate:=snapshot.amount_minor;
  for row in select * from public.transactions where account_id=account.id and workspace_id=account.workspace_id order by id loop
    if row.status='pending' and row.posted_on<=today and row.amount_minor<0 then
      if row.currency_code<>account.currency_code then return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor','0'); end if;
      holds:=holds-row.amount_minor;
    end if;
    if row.status<>'posted' then continue; end if;
    posting:=case when row.posted_at is not null then (row.posted_at at time zone p_timezone)::date else row.posted_on end;
    if posting<boundary or posting>today or (row.posted_at is not null and row.posted_at>p_as_of) or row.amount_minor=0 then continue; end if;
    if row.posted_at is not null and snapshot.boundary_kind='after_transaction' and snapshot.source_transaction_id is not null then
      if row.posted_at<snapshot.as_of then continue; end if;
      if row.posted_at=snapshot.as_of then
        if exists(select 1 from public.transaction_sources where transaction_id=row.id and source_transaction_id=snapshot.source_transaction_id) then continue; end if;
        return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor',holds::text);
      end if;
    elsif posting=boundary then
      return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor',holds::text);
    end if;
    if row.currency_code<>account.currency_code then return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor',holds::text); end if;
    estimate:=estimate+row.amount_minor;
  end loop;
  status:=case when boundary=today then 'current' else 'stale' end;
  return jsonb_build_object('status',status,'amount_minor',case when status='current' then estimate::text end,'estimated_amount_minor',estimate::text,'pending_hold_minor',holds::text);
end;
$$;
revoke all on function public.reservation_balance_evidence(uuid,timestamptz,text) from public,anon,authenticated;

create function public.reserve_goal_funds(p_goal_id uuid,p_account_id uuid,p_amount_minor text,p_expected_version integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare account public.accounts%rowtype; goal public.goals%rowtype; allocation public.goal_allocations%rowtype; prior public.goal_reservation_events%rowtype;
  amount bigint; old_amount bigint:=0; old_version integer:=0; evidence jsonb; timezone text; others numeric; event_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_amount_minor is null or p_amount_minor !~ '^[0-9]{1,19}$' or p_expected_version is null or p_expected_version<0 or p_request_id is null then raise exception 'Invalid reservation' using errcode='22023'; end if;
  begin amount:=p_amount_minor::bigint; exception when numeric_value_out_of_range then raise exception 'Reservation amount out of range' using errcode='22023'; end;
  select * into account from public.accounts where id=p_account_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  select * into goal from public.goals where id=p_goal_id and workspace_id=account.workspace_id for share;
  if not found then raise exception 'Goal not found' using errcode='P0002'; end if;
  select * into prior from public.goal_reservation_events where workspace_id=account.workspace_id and request_id=p_request_id;
  if found then
    if prior.after->>'goal_id' is distinct from p_goal_id::text or prior.after->>'account_id' is distinct from p_account_id::text or prior.after->>'amount_minor' is distinct from amount::text or (prior.before->>'version')::integer is distinct from p_expected_version then raise exception 'Request reused for another reservation' using errcode='22023'; end if;
    return jsonb_build_object('eventId',prior.id,'allocationId',prior.allocation_id,'version',prior.after->'version','undone',prior.undone_at is not null);
  end if;
  select * into allocation from public.goal_allocations where goal_id=p_goal_id and account_id=p_account_id for update;
  if found then old_amount:=allocation.amount_minor; old_version:=allocation.version; end if;
  if old_version is distinct from p_expected_version then raise exception 'Reservation changed; refresh before saving' using errcode='40001'; end if;
  -- Releasing reservations needs no new funding evidence, including after the account/goal changes.
  if amount>old_amount then
    if account.type not in ('checking','savings','cash','wallet') or goal.currency_code<>account.currency_code or goal.status<>'active' then raise exception 'Reserve only liquid cash in the active goal currency' using errcode='22023'; end if;
    select coalesce((select s.timezone from public.workspace_settings s where workspace_id=account.workspace_id),'Europe/Berlin') into timezone;
    evidence:=public.reservation_balance_evidence(account.id,now(),timezone);
    if evidence->>'status'<>'current' then raise exception 'A current unambiguous dated balance is required before reserving cash' using errcode='22023'; end if;
    select coalesce(sum(amount_minor),0) into others from public.goal_allocations where account_id=account.id and workspace_id=account.workspace_id and goal_id<>goal.id;
    if amount>(evidence->>'amount_minor')::numeric-(evidence->>'pending_hold_minor')::numeric-others then raise exception 'Reservation exceeds current unreserved cash after pending holds' using errcode='22003'; end if;
  end if;
  insert into public.goal_allocations(workspace_id,goal_id,account_id,amount_minor,version) values(account.workspace_id,goal.id,account.id,amount,old_version+1)
    on conflict(goal_id,account_id) do update set amount_minor=excluded.amount_minor,version=excluded.version returning * into allocation;
  insert into public.goal_reservation_events(workspace_id,allocation_id,actor_id,before,after,request_id)
    values(account.workspace_id,allocation.id,auth.uid(),jsonb_build_object('amount_minor',old_amount::text,'version',old_version),
      jsonb_build_object('goal_id',goal.id,'account_id',account.id,'amount_minor',amount::text,'version',allocation.version),p_request_id) returning id into event_id;
  return jsonb_build_object('eventId',event_id,'allocationId',allocation.id,'version',allocation.version,'undone',false);
end;
$$;

create or replace function public.set_goal_allocation(p_goal_id uuid,p_account_id uuid,p_amount_minor bigint)
returns public.goal_allocations language plpgsql security definer set search_path='' as $$
declare version integer; allocation public.goal_allocations%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  perform id from public.accounts where id=p_account_id and public.owns_workspace(workspace_id) for update;
  select coalesce((select a.version from public.goal_allocations a where goal_id=p_goal_id and account_id=p_account_id),0) into version;
  perform public.reserve_goal_funds(p_goal_id,p_account_id,p_amount_minor::text,version,gen_random_uuid());
  select * into allocation from public.goal_allocations where goal_id=p_goal_id and account_id=p_account_id;
  return allocation;
end;
$$;

create function public.undo_goal_reservation(p_event_id uuid,p_expected_version integer)
returns void language plpgsql security definer set search_path='' as $$
declare event public.goal_reservation_events%rowtype; allocation public.goal_allocations%rowtype; compensation jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into event from public.goal_reservation_events where id=p_event_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Reservation event not found' using errcode='P0002'; end if;
  select * into allocation from public.goal_allocations where id=event.allocation_id;
  perform id from public.accounts where id=allocation.account_id for update;
  select * into allocation from public.goal_allocations where id=event.allocation_id for update;
  select * into event from public.goal_reservation_events where id=p_event_id for update;
  if event.undone_at is not null then return; end if;
  if allocation.version is distinct from p_expected_version or allocation.amount_minor::text is distinct from event.after->>'amount_minor'
    or exists(select 1 from public.goal_reservation_events where allocation_id=allocation.id and undone_at is null and undo_of is null and (after->>'version')::integer>(event.after->>'version')::integer)
    then raise exception 'Reservation changed; undo latest change first' using errcode='40001'; end if;
  -- Restoring a larger reservation reuses the same current cash guard and records its own history.
  compensation:=public.reserve_goal_funds(allocation.goal_id,allocation.account_id,event.before->>'amount_minor',allocation.version,gen_random_uuid());
  update public.goal_reservation_events set undo_of=event.id where id=(compensation->>'eventId')::uuid;
  update public.goal_reservation_events set undone_at=now(),undone_by=auth.uid() where id=event.id;
end;
$$;
revoke all on function public.reserve_goal_funds(uuid,uuid,text,integer,uuid),public.undo_goal_reservation(uuid,integer) from public,anon;
grant execute on function public.reserve_goal_funds(uuid,uuid,text,integer,uuid),public.undo_goal_reservation(uuid,integer) to authenticated;
