-- Explicit lifecycle receipts preserve pending and posted observations unchanged.
create table public.pending_hold_resolutions (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  pending_transaction_id uuid references public.transactions(id) on delete set null,
  posted_transaction_id uuid references public.transactions(id) on delete set null,
  operation text not null check(operation in ('settle','cancel')),
  released_minor bigint not null check(released_minor>0), request_id uuid not null,
  input jsonb not null, receipt jsonb not null, note text not null check(length(btrim(note)) between 1 and 500),
  actor_id uuid not null references auth.users(id), created_at timestamptz not null default now(),
  undone_at timestamptz, undone_by uuid references auth.users(id), unique(workspace_id,request_id)
);
create index pending_hold_resolutions_active_pending on public.pending_hold_resolutions(pending_transaction_id) where undone_at is null;
create unique index pending_hold_resolutions_active_posted on public.pending_hold_resolutions(posted_transaction_id) where undone_at is null and posted_transaction_id is not null;
alter table public.pending_hold_resolutions enable row level security;
create policy pending_hold_resolutions_owned on public.pending_hold_resolutions for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.pending_hold_resolutions from public,anon,authenticated;
grant select on public.pending_hold_resolutions to authenticated,service_role;

create function public.resolve_pending_hold(p_pending_id uuid,p_expected_version integer,p_expected_released_minor bigint,p_posted_id uuid,p_posted_version integer,p_released_minor bigint,p_note text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pending public.transactions%rowtype; posted public.transactions%rowtype; prior public.pending_hold_resolutions%rowtype;
  released numeric; input jsonb; resolution uuid:=gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_pending_id is null or p_expected_version is null or p_expected_version<0 or p_expected_released_minor is null or p_expected_released_minor<0
    or p_released_minor is null or p_released_minor<=0 or p_note is null or length(btrim(p_note)) not between 1 and 500 or p_request_id is null
    or (p_posted_id is not null and (p_posted_version is null or p_posted_version<0 or p_posted_id=p_pending_id))
    or (p_posted_id is null and p_posted_version is not null) then raise exception 'Invalid pending resolution' using errcode='22023'; end if;
  -- Canonical rows before imports, consistently ordered with financial link/undo RPCs.
  perform id from public.transactions where id in(p_pending_id,p_posted_id) and public.owns_workspace(workspace_id) order by id for update;
  select * into pending from public.transactions where id=p_pending_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Pending transaction not found' using errcode='P0002'; end if;
  input:=jsonb_build_object('pendingId',p_pending_id,'pendingVersion',p_expected_version,'expectedReleasedMinor',p_expected_released_minor::text,
    'postedId',p_posted_id,'postedVersion',p_posted_version,'releasedMinor',p_released_minor::text,'note',btrim(p_note));
  select * into prior from public.pending_hold_resolutions where workspace_id=pending.workspace_id and request_id=p_request_id;
  if found then
    if prior.input is distinct from input then raise exception 'Request reused for another resolution' using errcode='22023'; end if;
    return jsonb_build_object('resolutionId',prior.id,'undone',prior.undone_at is not null);
  end if;
  select coalesce(sum(released_minor::numeric),0) into released from public.pending_hold_resolutions where pending_transaction_id=p_pending_id and undone_at is null;
  if pending.version<>p_expected_version or released<>p_expected_released_minor then raise exception 'Pending evidence changed; refresh before resolving' using errcode='PT409'; end if;
  if pending.status<>'pending' or pending.amount_minor>=0 or pending.kind<>'ordinary' or pending.transfer_id is not null or pending.refund_of_id is not null
    or released+p_released_minor>-(pending.amount_minor::numeric) then raise exception 'Release exceeds the outstanding pending debit' using errcode='22023'; end if;
  if exists(select 1 from public.recurring_occurrence_settlements where transaction_id=pending.id and undone_at is null)
    or exists(select 1 from public.wealth_items where payment_transaction_id=pending.id and removed_at is null)
    then raise exception 'Review recurring or debt associations before retiring this hold' using errcode='22023'; end if;
  if p_posted_id is not null then
    select * into posted from public.transactions where id=p_posted_id and workspace_id=pending.workspace_id;
    if not found then raise exception 'Settlement not found' using errcode='P0002'; end if;
    if posted.version<>p_posted_version then raise exception 'Settlement evidence changed; refresh before resolving' using errcode='PT409'; end if;
    if posted.status<>'posted' or posted.amount_minor>=0 or posted.kind<>'ordinary' or cardinality(posted.review_reasons)<>0
      or posted.account_id<>pending.account_id or posted.currency_code<>pending.currency_code or posted.transfer_id is not null or posted.refund_of_id is not null
      or posted.posted_on<pending.posted_on or exists(select 1 from public.pending_hold_resolutions where posted_transaction_id=posted.id and undone_at is null)
      then raise exception 'Settlement must be an unused reviewed debit in the same account and currency' using errcode='22023'; end if;
  end if;
  insert into public.pending_hold_resolutions(id,workspace_id,pending_transaction_id,posted_transaction_id,operation,released_minor,request_id,input,receipt,note,actor_id)
    values(resolution,pending.workspace_id,pending.id,posted.id,case when posted.id is null then 'cancel' else 'settle' end,p_released_minor,p_request_id,input,
      jsonb_build_object('pending',public.link_money_snapshot(pending),'posted',case when posted.id is not null then public.link_money_snapshot(posted) end),btrim(p_note),auth.uid());
  return jsonb_build_object('resolutionId',resolution,'undone',false);
end;
$$;

create function public.undo_pending_hold_resolution(p_resolution_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare resolution public.pending_hold_resolutions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into resolution from public.pending_hold_resolutions where id=p_resolution_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Resolution not found' using errcode='P0002'; end if;
  perform id from public.transactions where id in(resolution.pending_transaction_id,resolution.posted_transaction_id) order by id for update;
  select * into strict resolution from public.pending_hold_resolutions where id=p_resolution_id for update;
  if resolution.undone_at is null then
    -- Serialize restoration against account archival as well as competing hold resolutions.
    perform a.id from public.accounts a join public.transactions t on t.account_id=a.id where t.id=resolution.pending_transaction_id for share of a;
    if exists(select 1 from public.transactions t join public.accounts a on a.id=t.account_id where t.id=resolution.pending_transaction_id and a.archived_at is not null)
      then raise exception 'Unarchive the account before restoring its pending hold' using errcode='22023'; end if;
    update public.pending_hold_resolutions set undone_at=now(),undone_by=auth.uid() where id=resolution.id;
  end if;
  return jsonb_build_object('resolutionId',resolution.id,'undone',true);
end;
$$;

-- Acceptance and retirement are one transaction, including normalized/frozen-route checks.
create function public.settle_import_review(p_source_id uuid,p_pending_id uuid,p_pending_version integer,p_expected_released_minor bigint,p_released_minor bigint,p_note text,p_request_id uuid,
  p_expected_route_id uuid default null,p_account_id uuid default null,p_expected_account_version integer default null) returns public.source_transactions
language plpgsql security definer set search_path='' as $$
declare source public.source_transactions%rowtype; canonical_id uuid; posted public.transactions%rowtype; original_posted_version integer;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into source from public.source_transactions where id=p_source_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Review row not found' using errcode='P0002'; end if;
  canonical_id:=public.stable_import_uuid(source.import_id::text||':transaction:'||source.row_number);
  perform id from public.transactions where id in(p_pending_id,canonical_id) and public.owns_workspace(workspace_id) order by id for update;
  source:=public.resolve_normalized_import_review(p_source_id,'accept',p_expected_route_id,p_account_id,p_expected_account_version);
  select t.* into strict posted from public.transactions t join public.transaction_sources l on l.transaction_id=t.id where l.source_transaction_id=source.id;
  -- A retry retains its original evidence revision even if harmless metadata changed later.
  select (input->>'postedVersion')::integer into original_posted_version from public.pending_hold_resolutions where workspace_id=source.workspace_id and request_id=p_request_id;
  perform public.resolve_pending_hold(p_pending_id,p_pending_version,p_expected_released_minor,posted.id,coalesce(original_posted_version,posted.version),p_released_minor,p_note,p_request_id);
  return source;
end;
$$;

-- Financial evidence cannot change under an active retirement receipt; undo first.
create function public.guard_pending_hold_resolution() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.pending_hold_resolutions where undone_at is null and (pending_transaction_id=old.id or posted_transaction_id=old.id)) then
    if tg_op='DELETE' then raise exception 'Undo pending resolutions before removing transaction evidence' using errcode='22023'; end if;
    if (new.id,new.workspace_id,new.account_id,new.currency_code,new.amount_minor,new.status,new.kind,new.posted_on,new.posted_at,new.review_reasons,new.transfer_id,new.refund_of_id)
      is distinct from (old.id,old.workspace_id,old.account_id,old.currency_code,old.amount_minor,old.status,old.kind,old.posted_on,old.posted_at,old.review_reasons,old.transfer_id,old.refund_of_id)
      then raise exception 'Undo pending resolutions before changing financial evidence' using errcode='22023'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger transactions_pending_resolution_guard before update or delete on public.transactions for each row execute function public.guard_pending_hold_resolution();

-- Shared SQL reservation truth uses exactly the same outstanding hold as the TS reader.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.reservation_balance_evidence(uuid,timestamptz,text)'::regprocedure);
  if position('holds:=holds-row.amount_minor;' in definition)=0 then raise exception 'Expected pending hold resolver absent'; end if;
  definition:=replace(definition,'holds:=holds-row.amount_minor;',
    'holds:=holds-row.amount_minor-(select coalesce(sum(released_minor::numeric),0) from public.pending_hold_resolutions where pending_transaction_id=row.id and undone_at is null);');
  execute definition;
  definition:=pg_get_functiondef('public.guard_account_metadata()'::regprocedure);
  if position('account_id=old.id and status=''pending'' and amount_minor<0' in definition)=0 then raise exception 'Expected account pending guard absent'; end if;
  definition:=replace(definition,'account_id=old.id and status=''pending'' and amount_minor<0',
    'account_id=old.id and status=''pending'' and amount_minor<0 and -(amount_minor::numeric)>(select coalesce(sum(r.released_minor::numeric),0) from public.pending_hold_resolutions r where r.pending_transaction_id=transactions.id and r.undone_at is null)');
  execute definition;
  definition:=pg_get_functiondef('public.preview_import_undo(uuid)'::regprocedure);
  if position('  return jsonb_build_object(' in definition)=0 then raise exception 'Expected import preview absent'; end if;
  definition:=replace(definition,'  return jsonb_build_object(',
    '  if exists(select 1 from public.pending_hold_resolutions where undone_at is null and (pending_transaction_id=any(txn_ids) or posted_transaction_id=any(txn_ids))) then
    blockers:=array_append(blockers,''Undo pending hold resolutions before undoing this import'');
  end if;
  return jsonb_build_object(');
  execute definition;
end;
$$;
revoke all on function public.resolve_pending_hold(uuid,integer,bigint,uuid,integer,bigint,text,uuid),public.undo_pending_hold_resolution(uuid),
 public.settle_import_review(uuid,uuid,integer,bigint,bigint,text,uuid,uuid,uuid,integer),public.guard_pending_hold_resolution() from public,anon,authenticated;
grant execute on function public.resolve_pending_hold(uuid,integer,bigint,uuid,integer,bigint,text,uuid),public.undo_pending_hold_resolution(uuid),
 public.settle_import_review(uuid,uuid,integer,bigint,bigint,text,uuid,uuid,uuid,integer) to authenticated;
