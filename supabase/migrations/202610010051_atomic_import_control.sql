-- Cancellation serializes with every importer write; a resumed import has a new worker boundary.
alter table public.imports add column run_version integer not null default 1 check(run_version>0);
alter table public.imports add column route_accounts jsonb not null default '{}' check(jsonb_typeof(route_accounts)='object');
create table public.import_control_events (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  import_id uuid not null references public.imports(id), request_id uuid not null, action text not null check(action in ('cancel','resume')),
  result jsonb not null check(jsonb_typeof(result)='object'), actor_id uuid not null references auth.users(id), created_at timestamptz not null default now(),
  unique(workspace_id,request_id)
);
alter table public.import_control_events enable row level security;
create policy own_import_control_events on public.import_control_events for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.import_control_events from public,anon,authenticated;
grant select on public.import_control_events to authenticated;
grant all on public.import_control_events to service_role;
revoke update on public.imports from authenticated;
revoke update(status,error) on public.imports from authenticated;

create function public.control_import(p_import_id uuid,p_action text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; receipt public.import_control_events%rowtype; result jsonb; started boolean:=false; workspace uuid; previous_status text;
begin
  if p_import_id is null or p_request_id is null or p_action is null or p_action not in ('cancel','resume') then raise exception 'Invalid import control' using errcode='22023'; end if;
  select workspace_id into workspace from public.imports where id=p_import_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Import not found' using errcode='P0002'; end if;
  perform id from public.workspaces where id=workspace for update;
  select * into imported from public.imports where id=p_import_id and workspace_id=workspace for update;
  previous_status:=imported.status;
  select * into receipt from public.import_control_events where workspace_id=workspace and request_id=p_request_id;
  if found then
    if receipt.import_id is distinct from p_import_id or receipt.action is distinct from p_action then raise exception 'Import control request changed' using errcode='22023'; end if;
    return receipt.result||jsonb_build_object('started',false,'status',imported.status,'runVersion',imported.run_version);
  end if;
  if p_action='cancel' and imported.status in ('pending','queued','running') then
    update public.imports set status='canceled',error=null,run_version=run_version+1 where id=imported.id returning * into imported;
    perform public.recount_import_progress(imported.id);
    started:=true;
  elsif p_action='resume' and imported.status in ('failed','canceled') then
    if imported.total_rows<1 or jsonb_typeof(imported.mapping) is distinct from 'object' or imported.mapping->>'dateColumn' is null or imported.mapping->>'descriptionColumn' is null
      or left(imported.storage_path,length(workspace::text)+1) is distinct from workspace::text||'/'
      or exists(select 1 from public.import_control_events ce where ce.import_id=imported.id and ce.action='cancel' and ce.result->>'previousStatus'='pending') then raise exception 'Review and confirm the file mapping before starting this import' using errcode='22023'; end if;
    update public.imports set status='queued',error=null,run_version=run_version+1 where id=imported.id returning * into imported;
    started:=true;
  end if;
  result:=jsonb_build_object('importId',imported.id,'status',imported.status,'runVersion',imported.run_version,'totalRows',imported.total_rows,'started',started,'previousStatus',previous_status);
  insert into public.import_control_events(workspace_id,import_id,request_id,action,result,actor_id) values(workspace,imported.id,p_request_id,p_action,result,auth.uid());
  return result;
end;
$$;

create function public.lock_import_run(p_import_id uuid,p_workspace_id uuid,p_run_version integer) returns public.imports
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype;
begin
  if p_import_id is null or p_workspace_id is null or p_run_version is null or p_run_version<1 then raise exception 'Invalid import worker boundary' using errcode='22023'; end if;
  select * into imported from public.imports where id=p_import_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'Import not found' using errcode='P0002'; end if;
  if imported.run_version is distinct from p_run_version or imported.status not in ('queued','running') then raise exception 'Import worker canceled or superseded' using errcode='57014'; end if;
  return imported;
end;
$$;

create function public.prepare_import_route(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_account_id uuid,p_source_id uuid,p_account_name text,p_currency_code text,p_total_rows integer) returns void
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; account public.accounts%rowtype; route_key text; frozen_id uuid;
begin
  imported:=public.lock_import_run(p_import_id,p_workspace_id,p_run_version);
  if p_account_id is null or p_source_id is null or p_account_name is null or length(btrim(p_account_name)) not between 1 and 100 or p_currency_code is null or p_currency_code!~'^[A-Z]{3}$' or p_total_rows is null or p_total_rows<1 or p_total_rows is distinct from imported.total_rows then raise exception 'Invalid reviewed import route' using errcode='22023'; end if;
  route_key:=jsonb_build_array(p_account_name,p_currency_code)::text;
  frozen_id:=(imported.route_accounts->>route_key)::uuid;
  if frozen_id is null and imported.source_id is not null and exists(select 1 from public.data_sources where id=p_source_id and workspace_id=p_workspace_id and account_id=p_account_id and kind='file') then frozen_id:=p_account_id; end if;
  if frozen_id is not null and frozen_id is distinct from p_account_id then raise exception 'Reviewed import route identity changed' using errcode='22023'; end if;
  if frozen_id is null then
    if (select count(*) from public.accounts where workspace_id=p_workspace_id and name=p_account_name and currency_code=p_currency_code)>1 then raise exception 'Reviewed import account is ambiguous' using errcode='22023'; end if;
    if exists(select 1 from public.accounts where workspace_id=p_workspace_id and name=p_account_name and currency_code=p_currency_code and id<>p_account_id) then raise exception 'Import account selection changed; retry with current evidence' using errcode='40001'; end if;
  end if;
  insert into public.accounts(id,workspace_id,name,currency_code) values(p_account_id,p_workspace_id,p_account_name,p_currency_code) on conflict(id) do nothing;
  select * into strict account from public.accounts where id=p_account_id for share;
  if account.workspace_id is distinct from p_workspace_id or (frozen_id is null and account.name is distinct from p_account_name) or account.currency_code is distinct from p_currency_code or account.archived_at is not null then raise exception 'Reviewed import account is unavailable' using errcode='42501'; end if;
  insert into public.data_sources(id,workspace_id,account_id,kind,name) values(p_source_id,p_workspace_id,p_account_id,'file',p_account_name) on conflict(id) do nothing;
  if not exists(select 1 from public.data_sources where id=p_source_id and workspace_id=p_workspace_id and account_id=p_account_id and kind='file') then raise exception 'Import data source identity changed' using errcode='22023'; end if;
  update public.imports set status='running',error=null,source_id=coalesce(source_id,p_source_id),route_accounts=route_accounts||jsonb_build_object(route_key,p_account_id) where id=p_import_id;
end;
$$;

create function public.ingest_import_row(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_account_id uuid,p_row jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; source public.source_transactions%rowtype; canonical public.transactions%rowtype;
  source_id uuid; canonical_id uuid; balance_id uuid; action text; reasons text[]; merchant_id uuid; category_id uuid; merchant_name text; category_name text; linked_id uuid;
begin
  -- Correction/link RPCs lock canonical rows before recounting imports; preserve that lock order.
  if p_row is null or jsonb_typeof(p_row)<>'object' or octet_length(p_row::text)>11000000 then raise exception 'Invalid import row' using errcode='22023'; end if;
  canonical_id:=(p_row->>'transactionId')::uuid;
  perform id from public.transactions where id=canonical_id for update;
  imported:=public.lock_import_run(p_import_id,p_workspace_id,p_run_version);
  -- Serialize overlapping imports through their final candidate check and insert.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':'||p_account_id::text,0));
  source_id:=(p_row->>'sourceId')::uuid; balance_id:=(p_row->>'balanceId')::uuid; action:=p_row->>'action';
  if source_id is null or action is null or action not in ('new','matched','review') or (p_row->>'rowNumber')::integer is null or (p_row->>'rowNumber')::integer<2
    or jsonb_typeof(p_row->'originalRow') is distinct from 'object' or jsonb_typeof(p_row->'reviewReasons') is distinct from 'array'
    or p_row->>'currencyCode' is null or p_row->>'currencyCode'!~'^[A-Z]{3}$' or p_row->>'amountMinor' is null or p_row->>'amountMinor'!~'^-?[0-9]{1,19}$'
    or p_row->>'status' is null or p_row->>'status' not in ('posted','pending') or p_row->>'kind' is null or p_row->>'kind' not in ('ordinary','refund')
    or p_row->>'description' is null or length(p_row->>'description')>500 or p_row->>'postedOn' is null then raise exception 'Invalid import financial row' using errcode='22023'; end if;
  perform id from public.accounts where id=p_account_id and workspace_id=p_workspace_id and currency_code=p_row->>'currencyCode' and archived_at is null for share;
  if not found then raise exception 'Import account unavailable' using errcode='42501'; end if;
  select coalesce(array_agg(value),'{}') into reasons from jsonb_array_elements_text(p_row->'reviewReasons');
  insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,external_id,review_reasons,fee_evidence)
    values(source_id,p_workspace_id,p_import_id,(p_row->>'rowNumber')::integer,p_row->'originalRow',p_row->>'externalId',reasons,nullif(p_row->'feeEvidence','null'::jsonb)) on conflict(id) do nothing;
  select * into strict source from public.source_transactions where id=source_id for update;
  if source.workspace_id is distinct from p_workspace_id or source.import_id is distinct from p_import_id or source.row_number is distinct from (p_row->>'rowNumber')::integer or source.original_row is distinct from p_row->'originalRow' then raise exception 'Import source identity changed' using errcode='22023'; end if;
  select l.transaction_id into linked_id from public.transaction_sources l where l.source_transaction_id=source_id;
  if source.status in ('review','rejected') and linked_id is null then return jsonb_build_object('action',source.status); end if;
  if linked_id is not null then canonical_id:=linked_id; action:=source.status;
  elsif action='review' then
    update public.source_transactions set status='review' where id=source_id;
    if coalesce((p_row->>'reportProgress')::boolean,false) then perform public.recount_import_progress(p_import_id); end if;
    return jsonb_build_object('action','review');
  elsif action='matched' then
    select * into canonical from public.transactions where id=canonical_id and workspace_id=p_workspace_id for update;
    if not found or p_row->>'expectedTransactionVersion' is null or canonical.version is distinct from (p_row->>'expectedTransactionVersion')::integer
      or canonical.account_id is distinct from p_account_id or canonical.currency_code is distinct from p_row->>'currencyCode' or canonical.posted_on is distinct from (p_row->>'postedOn')::date
      or canonical.amount_minor is distinct from (p_row->>'amountMinor')::bigint or canonical.description is distinct from p_row->>'description' or canonical.status is distinct from p_row->>'status'
      or p_row->>'externalId' is null or not exists(select 1 from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where l.transaction_id=canonical_id and s.import_id<>p_import_id and s.external_id=p_row->>'externalId')
      or (select count(distinct t.id) from public.transactions t join public.transaction_sources l on l.transaction_id=t.id join public.source_transactions s on s.id=l.source_transaction_id where s.import_id<>p_import_id and s.external_id=p_row->>'externalId' and t.workspace_id=p_workspace_id and t.account_id=p_account_id and t.currency_code=p_row->>'currencyCode' and t.status=p_row->>'status')<>1 then raise exception 'Import match changed; retry with current evidence' using errcode='40001'; end if;
  else
    if canonical_id is null then raise exception 'Missing canonical identity' using errcode='22023'; end if;
    if exists(select 1 from public.transactions t where t.workspace_id=p_workspace_id and t.account_id=p_account_id and t.currency_code=p_row->>'currencyCode' and t.id<>canonical_id and
      not exists(select 1 from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where l.transaction_id=t.id and s.import_id=p_import_id) and
      ((t.posted_on=(p_row->>'postedOn')::date and t.amount_minor=(p_row->>'amountMinor')::bigint and t.description=p_row->>'description') or
      (p_row->>'externalId' is not null and exists(select 1 from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where l.transaction_id=t.id and s.external_id=p_row->>'externalId')))) then raise exception 'Import candidates changed; retry with current evidence' using errcode='40001'; end if;
    merchant_name:=nullif(btrim(p_row->>'merchantName'),''); category_name:=nullif(btrim(p_row->>'categoryName'),'');
    if merchant_name is not null then
      merchant_id:=(p_row->>'merchantId')::uuid;
      if merchant_id is null or length(merchant_name)>100 then raise exception 'Invalid import merchant' using errcode='22023'; end if;
      insert into public.merchants(id,workspace_id,name,normalized_name) values(merchant_id,p_workspace_id,merchant_name,coalesce(p_row->>'merchantNormalizedName',lower(merchant_name))) on conflict(workspace_id,normalized_name) do nothing;
      select id into merchant_id from public.merchants where workspace_id=p_workspace_id and normalized_name=coalesce(p_row->>'merchantNormalizedName',lower(merchant_name));
    end if;
    if category_name is not null then
      category_id:=(p_row->>'categoryId')::uuid;
      if category_id is null or length(category_name)>100 then raise exception 'Invalid import category' using errcode='22023'; end if;
      insert into public.categories(id,workspace_id,name) values(category_id,p_workspace_id,category_name) on conflict(workspace_id,name) do nothing;
      select id into category_id from public.categories where workspace_id=p_workspace_id and name=category_name;
    end if;
    insert into public.transactions(id,workspace_id,account_id,posted_on,posted_at,description,amount_minor,currency_code,status,kind,review_reasons,merchant_id,category_id)
      values(canonical_id,p_workspace_id,p_account_id,(p_row->>'postedOn')::date,(p_row->>'postedAt')::timestamptz,p_row->>'description',(p_row->>'amountMinor')::bigint,p_row->>'currencyCode',p_row->>'status',p_row->>'kind',reasons,merchant_id,category_id) on conflict(id) do nothing;
    select * into strict canonical from public.transactions where id=canonical_id;
    if canonical.workspace_id is distinct from p_workspace_id or canonical.account_id is distinct from p_account_id or canonical.currency_code is distinct from p_row->>'currencyCode' or canonical.amount_minor is distinct from (p_row->>'amountMinor')::bigint or canonical.posted_on is distinct from (p_row->>'postedOn')::date or canonical.description is distinct from p_row->>'description' or canonical.status is distinct from p_row->>'status' then raise exception 'Canonical import identity changed' using errcode='40001'; end if;
  end if;
  if linked_id is null then
    insert into public.transaction_sources(transaction_id,source_transaction_id) values(canonical_id,source_id);
    update public.source_transactions set status=action where id=source_id;
  end if;
  if p_row->>'balanceMinor' is not null and p_row->>'status'='posted' then
    select * into strict canonical from public.transactions where id=canonical_id and workspace_id=p_workspace_id;
    if canonical.account_id is distinct from p_account_id or canonical.currency_code is distinct from p_row->>'currencyCode' or balance_id is null or p_row->>'balanceAsOf' is null or p_row->>'balanceMinor'!~'^-?[0-9]{1,19}$' then raise exception 'Invalid balance source boundary' using errcode='22023'; end if;
    insert into public.balance_snapshots(id,workspace_id,account_id,amount_minor,currency_code,as_of,boundary_kind,source_transaction_id,provenance)
      values(balance_id,p_workspace_id,p_account_id,(p_row->>'balanceMinor')::bigint,p_row->>'currencyCode',(p_row->>'balanceAsOf')::timestamptz,
        case when p_row->>'postedAt' is not null and canonical.posted_at=(p_row->>'postedAt')::timestamptz then 'after_transaction' else 'date_only' end,source_id,'import:'||p_import_id||':row:'||(p_row->>'rowNumber')) on conflict(id) do nothing;
    if not exists(select 1 from public.balance_snapshots where id=balance_id and workspace_id=p_workspace_id and account_id=p_account_id and source_transaction_id=source_id and amount_minor=(p_row->>'balanceMinor')::bigint and currency_code=p_row->>'currencyCode' and as_of=(p_row->>'balanceAsOf')::timestamptz) then raise exception 'Import balance identity changed' using errcode='22023'; end if;
  end if;
  if coalesce((p_row->>'reportProgress')::boolean,false) then perform public.recount_import_progress(p_import_id); end if;
  return jsonb_build_object('action',action);
end;
$$;

create function public.finish_import_run(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_error text default null) returns text
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype;
begin
  if p_run_version is null or p_run_version<1 then raise exception 'Invalid import worker boundary' using errcode='22023'; end if;
  select * into imported from public.imports where id=p_import_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'Import not found' using errcode='P0002'; end if;
  if imported.run_version is distinct from p_run_version or imported.status not in ('queued','running') then return imported.status; end if;
  perform public.recount_import_progress(imported.id);
  if p_error is null and (select count(*) from public.source_transactions where import_id=imported.id)<>imported.total_rows then raise exception 'Import source coverage is incomplete' using errcode='22023'; end if;
  update public.imports set status=case when p_error is null then 'completed' else 'failed' end,error=left(p_error,2000) where id=imported.id returning status into imported.status;
  return imported.status;
end;
$$;
revoke all on function public.control_import(uuid,text,uuid),public.lock_import_run(uuid,uuid,integer),public.prepare_import_route(uuid,uuid,integer,uuid,uuid,text,text,integer),public.ingest_import_row(uuid,uuid,integer,uuid,jsonb),public.finish_import_run(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.control_import(uuid,text,uuid) to authenticated;
grant execute on function public.prepare_import_route(uuid,uuid,integer,uuid,uuid,text,text,integer),public.ingest_import_row(uuid,uuid,integer,uuid,jsonb),public.finish_import_run(uuid,uuid,integer,text) to service_role;

-- Keep the established undo checks, with the canonical-before-import lock order
-- used by corrections and ingestion. Recheck the source graph under the lock.
alter function public.undo_import(uuid,integer,integer) rename to undo_import_before_control;
revoke all on function public.undo_import_before_control(uuid,integer,integer) from public,anon,authenticated,service_role;
create function public.undo_import(p_import_id uuid,p_expected_transactions integer,p_expected_balances integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; locked_ids uuid[]; current_ids uuid[];
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into imported from public.imports where id=p_import_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Import not found' using errcode='P0002'; end if;
  select coalesce(array_agg(distinct l.transaction_id order by l.transaction_id),'{}'::uuid[]) into locked_ids
    from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id
    where s.import_id=p_import_id and s.workspace_id=imported.workspace_id;
  perform t.id from public.transactions t where t.id=any(locked_ids) and t.workspace_id=imported.workspace_id order by t.id for update;
  select * into imported from public.imports where id=p_import_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Import not found' using errcode='P0002'; end if;
  select coalesce(array_agg(distinct l.transaction_id order by l.transaction_id),'{}'::uuid[]) into current_ids
    from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id
    where s.import_id=p_import_id and s.workspace_id=imported.workspace_id;
  if current_ids is distinct from locked_ids then raise exception 'Import changed; refresh the preview and confirm again' using errcode='40001'; end if;
  return public.undo_import_before_control(p_import_id,p_expected_transactions,p_expected_balances);
end;
$$;
revoke all on function public.undo_import(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.undo_import(uuid,integer,integer) to authenticated;
