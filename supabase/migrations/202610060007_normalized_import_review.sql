-- Keep the reviewed normalized interpretation beside its immutable source observation.
-- Authenticated clients cannot write source records or invoke the ingestion core.
alter table public.source_transactions add column normalized_row jsonb check(normalized_row is null or jsonb_typeof(normalized_row)='object');

-- PostgreSQL's built-in SHA256 avoids depending on pgcrypto's installation schema.
create or replace function public.stable_import_uuid(p_key text) returns uuid
language plpgsql immutable security definer set search_path='' as $$
declare hex text;
begin
  if p_key is null then raise exception 'stable key required' using errcode='22023'; end if;
  hex:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_key,'UTF8')),'hex');
  return (substr(hex,1,8)||'-'||substr(hex,9,4)||'-4'||substr(hex,14,3)||'-a'||substr(hex,18,3)||'-'||substr(hex,21,12))::uuid;
end;
$$;

create function public.ingest_import_row_internal(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_account_id uuid,p_row jsonb,p_review boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; source public.source_transactions%rowtype; canonical public.transactions%rowtype;
  source_id uuid; canonical_id uuid; balance_id uuid; action text; reasons text[]; merchant_id uuid; category_id uuid; merchant_name text; category_name text; linked_id uuid;
begin
  -- Correction/link RPCs lock canonical rows before recounting imports; preserve that lock order.
  if p_row is null or jsonb_typeof(p_row)<>'object' or octet_length(p_row::text)>11000000 then raise exception 'Invalid import row' using errcode='22023'; end if;
  canonical_id:=(p_row->>'transactionId')::uuid;
  perform id from public.transactions where id=canonical_id for update;
  if p_review then
    select * into strict imported from public.imports where id=p_import_id and workspace_id=p_workspace_id for update;
    if imported.status<>'completed' or imported.run_version is distinct from p_run_version then raise exception 'Import changed' using errcode='40001'; end if;
  else
    imported:=public.lock_import_run(p_import_id,p_workspace_id,p_run_version);
  end if;
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
  if not p_review and source.status in ('review','rejected') and linked_id is null then return jsonb_build_object('action',source.status); end if;
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
    if not p_review and exists(select 1 from public.transactions t where t.workspace_id=p_workspace_id and t.account_id=p_account_id and t.currency_code=p_row->>'currencyCode' and t.id<>canonical_id and
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

revoke all on function public.ingest_import_row_internal(uuid,uuid,integer,uuid,jsonb,boolean) from public,anon,authenticated,service_role;

create or replace function public.ingest_import_row(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_account_id uuid,p_row jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; imported public.imports%rowtype; envelope jsonb; source public.source_transactions%rowtype; route_key text;
begin
  result:=public.ingest_import_row_internal(p_import_id,p_workspace_id,p_run_version,p_account_id,p_row,false);
  select * into strict imported from public.imports where id=p_import_id;
  if p_row->>'accountName' is not null then
    route_key:=jsonb_build_array(p_row->>'accountName',p_row->>'currencyCode')::text;
    if (imported.route_accounts->>route_key)::uuid is distinct from p_account_id then raise exception 'Frozen import route changed' using errcode='40001'; end if;
    envelope:=jsonb_build_object('row',p_row-array['action','transactionId','expectedTransactionVersion','reportProgress'],'mapping',imported.mapping,'routeKey',route_key,'accountId',p_account_id);
    select * into strict source from public.source_transactions where id=(p_row->>'sourceId')::uuid for update;
    if source.normalized_row is not null and source.normalized_row is distinct from envelope then raise exception 'Normalized source changed' using errcode='40001'; end if;
    update public.source_transactions set normalized_row=envelope where id=source.id;
  end if;
  return result;
end;
$$;

-- Legacy completed imports are normalized by the trusted server using all original
-- observations and saved decisions. Snapshot checks fence concurrent remapping/undo.
create function public.prepare_import_review(p_source_id uuid,p_workspace_id uuid,p_mapping jsonb,p_routes jsonb,p_row jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; source public.source_transactions%rowtype; route_key text; envelope jsonb;
begin
  select * into strict source from public.source_transactions where id=p_source_id and workspace_id=p_workspace_id;
  select * into strict imported from public.imports where id=source.import_id and workspace_id=p_workspace_id for update;
  select * into strict source from public.source_transactions where id=p_source_id for update;
  if imported.status<>'completed' or imported.mapping is distinct from p_mapping or imported.route_accounts is distinct from p_routes
    or source.original_row is distinct from p_row->'originalRow' or source.row_number is distinct from (p_row->>'rowNumber')::integer
    or source.id is distinct from (p_row->>'sourceId')::uuid or source.status<>'review' then raise exception 'Review evidence changed' using errcode='40001'; end if;
  route_key:=jsonb_build_array(p_row->>'accountName',p_row->>'currencyCode')::text;
  envelope:=jsonb_build_object('row',p_row,'mapping',p_mapping,'routeKey',route_key,'accountId',p_routes->route_key);
  if source.normalized_row is not null and source.normalized_row is distinct from envelope then raise exception 'Normalized source changed' using errcode='40001'; end if;
  update public.source_transactions set normalized_row=envelope, fee_evidence=nullif(p_row->'feeEvidence','null'::jsonb),
    review_reasons=array(select jsonb_array_elements_text(p_row->'reviewReasons')) where id=source.id;
end;
$$;
revoke all on function public.prepare_import_review(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_import_review(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

-- Retire both authenticated value-taking signatures: no parser/routing bypass.
revoke all on function public.resolve_import_review(uuid,text,date,text,bigint,text) from public,anon,authenticated,service_role;
revoke all on function public.resolve_import_review_before_classification(uuid,text,date,text,bigint,text) from public,anon,authenticated,service_role;

create function public.resolve_normalized_import_review(p_source_id uuid,p_action text,p_expected_route_id uuid default null,p_account_id uuid default null,p_expected_account_version integer default null)
returns public.source_transactions language plpgsql security definer set search_path='' as $$
declare source public.source_transactions%rowtype; imported public.imports%rowtype; destination public.accounts%rowtype; row jsonb; frozen uuid; canonical_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_action is null or p_action not in ('accept','reject') then raise exception 'Invalid review action' using errcode='22023'; end if;
  select * into source from public.source_transactions where id=p_source_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Review row not found' using errcode='P0002'; end if;
  -- Same canonical-before-import order as ingestion and undo.
  canonical_id:=public.stable_import_uuid(source.import_id::text||':transaction:'||source.row_number);
  perform id from public.transactions where id=canonical_id for update;
  select * into strict imported from public.imports where id=source.import_id and workspace_id=source.workspace_id for update;
  select * into strict source from public.source_transactions where id=p_source_id for update;
  if imported.status<>'completed' then raise exception 'Import is not completed' using errcode='40001'; end if;
  if source.status=(case when p_action='accept' then 'accepted' else 'rejected' end) then
    if p_action='accept' and p_account_id is not null and (not exists(select 1 from public.transaction_sources l join public.transactions t on t.id=l.transaction_id where l.source_transaction_id=source.id and t.account_id=p_account_id) or p_expected_route_id is distinct from (source.normalized_row->'resolution'->>'frozenAccountId')::uuid or p_expected_account_version is distinct from (source.normalized_row->'resolution'->>'accountVersion')::integer) then
      raise exception 'Accepted destination differs from retry' using errcode='40001';
    end if;
    return source;
  end if;
  if source.status<>'review' then raise exception 'Row already resolved' using errcode='40001'; end if;
  if p_action='reject' then
    update public.source_transactions set status='rejected' where id=source.id returning * into source;
  else
    if source.normalized_row is null or source.normalized_row->'mapping' is distinct from imported.mapping then raise exception 'Normalize the reviewed original before acceptance' using errcode='22023'; end if;
    row:=source.normalized_row->'row';
    frozen:=(source.normalized_row->>'accountId')::uuid;
    if (imported.route_accounts->>(source.normalized_row->>'routeKey'))::uuid is distinct from frozen then raise exception 'Frozen route changed' using errcode='40001'; end if;
    if p_account_id is not null then
      if p_expected_route_id is distinct from frozen or p_expected_account_version is null then raise exception 'Reviewed destination snapshot required' using errcode='40001'; end if;
      select * into destination from public.accounts where id=p_account_id and workspace_id=source.workspace_id and currency_code=row->>'currencyCode' and archived_at is null for share;
      if not found then raise exception 'Reviewed destination unavailable' using errcode='42501'; end if;
      if destination.version is distinct from p_expected_account_version then raise exception 'Destination changed; review again' using errcode='40001'; end if;
    else
      select * into destination from public.accounts where id=frozen and workspace_id=source.workspace_id and currency_code=row->>'currencyCode' and archived_at is null for share;
      if not found then raise exception 'Frozen destination unavailable; explicitly review an owned destination' using errcode='42501'; end if;
    end if;
    perform public.ingest_import_row_internal(imported.id,source.workspace_id,imported.run_version,destination.id,
      row||jsonb_build_object('action','new','transactionId',canonical_id,'reportProgress',false),true);
    update public.source_transactions set status='accepted', normalized_row=normalized_row||jsonb_build_object('resolution',
      jsonb_build_object('accountId',destination.id,'frozenAccountId',frozen,'accountVersion',destination.version,'actorId',auth.uid()))
      where id=source.id returning * into source;
  end if;
  perform public.recount_import_progress(imported.id);
  return source;
end;
$$;
revoke all on function public.resolve_normalized_import_review(uuid,text,uuid,uuid,integer) from public,anon;
grant execute on function public.resolve_normalized_import_review(uuid,text,uuid,uuid,integer) to authenticated;

-- A frozen UUID is evidence, never permission to recreate a removed account.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.prepare_import_route(uuid,uuid,integer,uuid,uuid,text,text,integer)'::regprocedure);
  if position('  insert into public.accounts(id,workspace_id,name,currency_code)' in definition)=0 then raise exception 'Expected import route insertion absent'; end if;
  definition:=replace(definition,'  insert into public.accounts(id,workspace_id,name,currency_code)',
    '  if frozen_id is not null and not exists(select 1 from public.accounts where id=frozen_id) then raise exception ''Frozen import account unavailable; explicitly review the destination'' using errcode=''42501''; end if;
  insert into public.accounts(id,workspace_id,name,currency_code)');
  execute definition;
end;
$$;
