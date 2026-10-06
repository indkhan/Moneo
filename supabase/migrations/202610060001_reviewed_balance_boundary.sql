-- Manual reconciliation reuses append-only snapshot history. Receipts preserve the exact
-- canonical rows the user saw; timestamps alone never imply bank coverage.
alter table public.balance_snapshots add column covered_transactions jsonb;
alter table public.balance_snapshots add column actor_id uuid references auth.users(id);
alter table public.balance_snapshots add column command_input jsonb;
alter table public.balance_snapshots add column version integer not null default 1 check(version>0);
alter table public.balance_snapshots add column undone_at timestamptz;
alter table public.balance_snapshots add column undone_by uuid references auth.users(id);
alter table public.balance_snapshots drop constraint balance_snapshots_boundary_kind_check;
alter table public.balance_snapshots add constraint balance_snapshots_boundary_kind_check check
  (boundary_kind in ('date_only','after_transaction','reviewed_activity') and
   (boundary_kind<>'after_transaction' or source_transaction_id is not null) and
   (boundary_kind<>'reviewed_activity' or (covered_transactions is not null and jsonb_typeof(covered_transactions)='array' and actor_id is not null)));
-- All app writers now use guarded RPCs; authenticated clients cannot forge reviewed receipts/history.
revoke insert,update,delete on public.balance_snapshots from authenticated;

create function public.balance_review_record(p_row public.transactions) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',p_row.id,'version',p_row.version,
    'amount_minor',(p_row.amount_minor::numeric-coalesce((select sum(f.fee_minor) from public.transaction_link_fees f
      join public.transaction_links l on l.id=f.link_id and l.workspace_id=f.workspace_id
      where f.transaction_id=p_row.id and f.workspace_id=p_row.workspace_id and f.treatment='additional' and l.undone_at is null),0))::text,
    'currency_code',p_row.currency_code,'posted_on',p_row.posted_on::text,
    'posted_at',case when p_row.posted_at is not null then to_char(p_row.posted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end);
$$;
revoke all on function public.balance_review_record(public.transactions) from public,anon,authenticated;

create function public.record_manual_balance(p_account_id uuid,p_amount_minor text,p_date date,p_reviewed boolean,
  p_covered_transactions jsonb,p_expected_snapshot_id uuid,p_expected_version integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare account public.accounts%rowtype; latest public.balance_snapshots%rowtype; prior public.balance_snapshots%rowtype;
  timezone text; observation timestamptz:=clock_timestamp(); amount bigint; actual jsonb; input jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_amount_minor is null or p_amount_minor !~ '^-?[0-9]{1,19}$' or p_date is null or p_reviewed is null or
     p_expected_version is null or p_expected_version<0 or p_request_id is null then raise exception 'Invalid balance command' using errcode='22023'; end if;
  begin amount:=p_amount_minor::bigint; exception when numeric_value_out_of_range then raise exception 'Balance amount out of range' using errcode='22023'; end;
  select * into account from public.accounts where id=p_account_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  -- Corrections/imports lock canonical rows first. Share their lock order, then fence
  -- new import rows with the existing advisory lock and new manual rows with the account.
  perform id from public.transactions where account_id=account.id and workspace_id=account.workspace_id order by id for share;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(account.workspace_id::text||':'||p_account_id::text,0));
  select * into account from public.accounts where id=p_account_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  input:=jsonb_build_object('accountId',p_account_id,'amountMinor',amount::text,'date',p_date,'reviewed',p_reviewed,
    'coveredTransactions',p_covered_transactions,'expectedSnapshotId',p_expected_snapshot_id,'expectedVersion',p_expected_version);
  select * into prior from public.balance_snapshots where id=p_request_id;
  if found then
    if prior.workspace_id<>account.workspace_id or prior.actor_id is distinct from auth.uid() or prior.command_input is distinct from input
      then raise exception 'Request reused for another balance' using errcode='22023'; end if;
    return jsonb_build_object('snapshotId',prior.id,'version',prior.version,'undone',prior.undone_at is not null);
  end if;
  select * into latest from public.balance_snapshots where account_id=account.id and workspace_id=account.workspace_id order by created_at desc,id desc limit 1 for update;
  if latest.id is distinct from p_expected_snapshot_id or coalesce(latest.version,0)<>p_expected_version
    then raise exception 'Balance history changed; refresh before saving' using errcode='40001'; end if;
  select coalesce((select s.timezone from public.workspace_settings s where workspace_id=account.workspace_id),'Europe/Berlin') into timezone;
  observation:=date_trunc('milliseconds',clock_timestamp());
  if p_date>(observation at time zone timezone)::date then raise exception 'Balance date cannot be in the future' using errcode='22023'; end if;
  if p_reviewed then
    if p_date<>(observation at time zone timezone)::date or p_covered_transactions is null or jsonb_typeof(p_covered_transactions)<>'array'
      or jsonb_array_length(p_covered_transactions)>5000 then raise exception 'Review applies only to today''s booked activity' using errcode='22023'; end if;
    select coalesce(jsonb_agg(public.balance_review_record(t) order by t.id),'[]'::jsonb) into actual
      from public.transactions t where t.account_id=account.id and t.workspace_id=account.workspace_id and t.status='posted'
      and (case when t.posted_at is not null then (t.posted_at at time zone timezone)::date else t.posted_on end)=p_date
      and (t.posted_at is null or t.posted_at<=observation) and (public.balance_review_record(t)->>'amount_minor')::numeric<>0;
    if actual is distinct from p_covered_transactions then raise exception 'Recorded activity changed; refresh and review the balance again' using errcode='40001'; end if;
    if exists(select 1 from jsonb_array_elements(actual) item where item->>'currency_code'<>account.currency_code)
      then raise exception 'Reviewed activity currency differs from account' using errcode='22023'; end if;
  elsif p_covered_transactions is not null then raise exception 'Unconfirmed balance cannot carry reviewed coverage' using errcode='22023'; end if;
  insert into public.balance_snapshots(id,workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,
    covered_transactions,actor_id,command_input,created_at)
  values(p_request_id,account.workspace_id,account.id,amount,account.currency_code,
    case when p_date=(observation at time zone timezone)::date then observation else p_date::timestamp at time zone timezone end,
    'manual',case when p_reviewed then 'reviewed_activity' else 'date_only' end,actual,auth.uid(),input,clock_timestamp());
  return jsonb_build_object('snapshotId',p_request_id,'version',1,'undone',false);
end;
$$;

create function public.undo_manual_balance(p_snapshot_id uuid,p_expected_version integer,p_expected_latest_id uuid,p_expected_latest_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare snapshot public.balance_snapshots%rowtype; latest public.balance_snapshots%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into snapshot from public.balance_snapshots where id=p_snapshot_id and public.owns_workspace(workspace_id);
  if not found or snapshot.command_input is null then raise exception 'Manual balance history not found' using errcode='P0002'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(snapshot.workspace_id::text||':'||snapshot.account_id::text,0));
  perform id from public.accounts where id=snapshot.account_id for update;
  select * into snapshot from public.balance_snapshots where id=p_snapshot_id for update;
  if snapshot.undone_at is not null then return jsonb_build_object('snapshotId',snapshot.id,'version',snapshot.version,'undone',true); end if;
  select * into latest from public.balance_snapshots where account_id=snapshot.account_id order by created_at desc,id desc limit 1 for update;
  if p_expected_version is null or snapshot.version<>p_expected_version or latest.id is distinct from p_expected_latest_id or latest.version is distinct from p_expected_latest_version
    or exists(select 1 from public.balance_snapshots where account_id=snapshot.account_id and undone_at is null and
      (created_at,id)>(snapshot.created_at,snapshot.id)) then raise exception 'Balance changed; undo newer balances first' using errcode='40001'; end if;
  update public.balance_snapshots set undone_at=clock_timestamp(),undone_by=auth.uid(),version=version+1 where id=snapshot.id returning * into snapshot;
  return jsonb_build_object('snapshotId',snapshot.id,'version',snapshot.version,'undone',true);
end;
$$;
revoke all on function public.record_manual_balance(uuid,text,date,boolean,jsonb,uuid,integer,uuid),public.undo_manual_balance(uuid,integer,uuid,integer) from public,anon;
grant execute on function public.record_manual_balance(uuid,text,date,boolean,jsonb,uuid,integer,uuid),public.undo_manual_balance(uuid,integer,uuid,integer) to authenticated;

create or replace function public.reservation_balance_evidence(p_account_id uuid,p_as_of timestamptz,p_timezone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare account public.accounts%rowtype; snapshot public.balance_snapshots%rowtype; row public.transactions%rowtype;
  today date:=(p_as_of at time zone p_timezone)::date; boundary date; posting date; estimate numeric; holds numeric:=0; status text; covered jsonb; record jsonb; delta numeric;
begin
  select * into account from public.accounts where id=p_account_id for update;
  if not found then return jsonb_build_object('status','missing','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor','0'); end if;
  perform id from public.balance_snapshots where account_id=account.id and workspace_id=account.workspace_id order by id for share;
  perform id from public.transactions where account_id=account.id and workspace_id=account.workspace_id order by id for share;
  select * into snapshot from public.balance_snapshots where account_id=account.id and workspace_id=account.workspace_id and undone_at is null and as_of<=p_as_of order by as_of desc,id limit 1;
  if not found then return jsonb_build_object('status','missing','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor','0'); end if;
  if snapshot.currency_code<>account.currency_code or exists(select 1 from public.balance_snapshots where account_id=account.id and workspace_id=account.workspace_id and undone_at is null and as_of=snapshot.as_of
    and (currency_code<>snapshot.currency_code or amount_minor<>snapshot.amount_minor or boundary_kind<>snapshot.boundary_kind or source_transaction_id is distinct from snapshot.source_transaction_id or covered_transactions is distinct from snapshot.covered_transactions)) then
    return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor','0'); end if;
  boundary:=(snapshot.as_of at time zone p_timezone)::date;
  estimate:=snapshot.amount_minor;
  if snapshot.boundary_kind='reviewed_activity' then
    if (select count(*) from jsonb_array_elements(snapshot.covered_transactions))<>(select count(distinct c->>'id') from jsonb_array_elements(snapshot.covered_transactions) c) then
      return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor','0'); end if;
    for covered in select value from jsonb_array_elements(snapshot.covered_transactions) loop
      if not exists(select 1 from public.transactions t where t.id=(covered->>'id')::uuid and t.account_id=account.id and t.workspace_id=account.workspace_id and t.status='posted'
        and t.currency_code=account.currency_code and (t.posted_at is null or t.posted_at<=snapshot.as_of) and public.balance_review_record(t)=covered) then
        return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor','0'); end if;
    end loop;
  end if;
  for row in select * from public.transactions where account_id=account.id and workspace_id=account.workspace_id order by id loop
    if row.status='pending' and row.posted_on<=today and row.amount_minor<0 then
      if row.currency_code<>account.currency_code then return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor','0'); end if;
      holds:=holds-row.amount_minor;
    end if;
    if row.status<>'posted' then continue; end if;
    record:=public.balance_review_record(row); delta:=(record->>'amount_minor')::numeric;
    if snapshot.boundary_kind='reviewed_activity' and exists(select 1 from jsonb_array_elements(snapshot.covered_transactions) c where c->>'id'=row.id::text) then continue; end if;
    posting:=case when row.posted_at is not null then (row.posted_at at time zone p_timezone)::date else row.posted_on end;
    if posting<boundary or posting>today or (row.posted_at is not null and row.posted_at>p_as_of) or delta=0 then continue; end if;
    if snapshot.boundary_kind='reviewed_activity' and posting=boundary then
      if row.posted_at is null or date_trunc('milliseconds',row.posted_at)<=date_trunc('milliseconds',snapshot.as_of) then
        return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor',holds::text); end if;
    elsif row.posted_at is not null and snapshot.boundary_kind='after_transaction' and snapshot.source_transaction_id is not null then
      if row.posted_at<snapshot.as_of then continue; end if;
      if row.posted_at=snapshot.as_of then
        if exists(select 1 from public.transaction_sources where transaction_id=row.id and source_transaction_id=snapshot.source_transaction_id) then continue; end if;
        return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor',holds::text);
      end if;
    elsif posting=boundary then
      return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor',holds::text);
    end if;
    if row.currency_code<>account.currency_code then return jsonb_build_object('status','ambiguous','amount_minor',null,'estimated_amount_minor',null,'pending_hold_minor',holds::text); end if;
    estimate:=estimate+delta;
  end loop;
  status:=case when boundary=today then 'current' else 'stale' end;
  return jsonb_build_object('status',status,'amount_minor',case when status='current' then estimate::text end,'estimated_amount_minor',estimate::text,'pending_hold_minor',holds::text);
end;
$$;
revoke all on function public.reservation_balance_evidence(uuid,timestamptz,text) from public,anon,authenticated;


-- Evaluate after the account lock, including a balance committed while this command waited.
create or replace function public.reserve_goal_funds(p_goal_id uuid,p_account_id uuid,p_amount_minor text,p_expected_version integer,p_request_id uuid)
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
    evidence:=public.reservation_balance_evidence(account.id,clock_timestamp(),timezone);
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

