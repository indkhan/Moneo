-- Service-only immutable reviewed preparation. No client can supply or mutate
-- staged financial payloads; every writer still uses the established row core.
create table public.import_staging (
  import_id uuid primary key references public.imports(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id),
  stage_version integer not null check(stage_version=1),
  file_hash text not null,
  mapping jsonb not null,
  route_accounts jsonb not null,
  rows jsonb not null check(jsonb_typeof(rows)='array' and jsonb_array_length(rows)<=10000 and octet_length(rows::text)<=64000000),
  created_at timestamptz not null default now()
);
alter table public.import_staging enable row level security;
revoke all on public.import_staging from public,anon,authenticated,service_role;

create function public.prevent_import_staging_update() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Normalized import staging is immutable' using errcode='22023'; end;
$$;
create trigger import_staging_immutable before update on public.import_staging for each row execute function public.prevent_import_staging_update();
revoke all on function public.prevent_import_staging_update() from public,anon,authenticated,service_role;

create function public.read_import_stage(p_import_id uuid,p_workspace_id uuid,p_run_version integer) returns integer
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; staged public.import_staging%rowtype;
begin
  imported:=public.lock_import_run(p_import_id,p_workspace_id,p_run_version);
  select * into staged from public.import_staging where import_id=p_import_id and workspace_id=p_workspace_id;
  if not found then return null; end if;
  if staged.file_hash is distinct from imported.file_hash or staged.mapping is distinct from imported.mapping or staged.route_accounts is distinct from imported.route_accounts then raise exception 'Reviewed import staging identity changed' using errcode='40001'; end if;
  return jsonb_array_length(staged.rows);
end;
$$;

create function public.stage_import_rows(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_file_hash text,p_rows jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; item jsonb; row_index integer:=2; previous_count integer;
begin
  imported:=public.lock_import_run(p_import_id,p_workspace_id,p_run_version);
  if imported.file_hash is distinct from p_file_hash or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)<>imported.total_rows
    or imported.total_rows>10000 or octet_length(p_rows::text)>64000000 then raise exception 'Invalid normalized import staging' using errcode='22023'; end if;
  previous_count:=public.read_import_stage(p_import_id,p_workspace_id,p_run_version);
  if previous_count is not null then
    if not exists(select 1 from public.import_staging where import_id=p_import_id and rows=p_rows) then raise exception 'Normalized import staging changed' using errcode='40001'; end if;
    return previous_count;
  end if;
  for item in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'row') is distinct from 'object' or (item->'row'->>'rowNumber')::integer is distinct from row_index
      or (item->'row'->>'sourceId')::uuid is distinct from public.stable_import_uuid(p_import_id::text||':row:'||row_index)
      or jsonb_typeof(item->'row'->'originalRow') is distinct from 'object' or jsonb_typeof(item->'excluded') is distinct from 'boolean' then raise exception 'Invalid staged source identity' using errcode='22023'; end if;
    if not (item->>'excluded')::boolean then
      if (imported.route_accounts->>jsonb_build_array(item->'row'->>'accountName',item->'row'->>'currencyCode')::text)::uuid is distinct from (item->>'accountId')::uuid
        or not exists(select 1 from public.accounts where id=(item->>'accountId')::uuid and workspace_id=p_workspace_id and currency_code=item->'row'->>'currencyCode' and archived_at is null) then raise exception 'Frozen staged account unavailable' using errcode='42501'; end if;
    end if;
    row_index:=row_index+1;
  end loop;
  insert into public.import_staging(import_id,workspace_id,stage_version,file_hash,mapping,route_accounts,rows)
    values(p_import_id,p_workspace_id,1,p_file_hash,imported.mapping,imported.route_accounts,p_rows);
  return imported.total_rows;
end;
$$;

create function public.import_batch_candidates(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_offset integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare total integer; item jsonb; candidates jsonb; result jsonb:='[]'::jsonb;
begin
  total:=public.read_import_stage(p_import_id,p_workspace_id,p_run_version);
  if total is null or p_offset is null or p_offset<0 or p_offset%250<>0 or p_offset>=total then raise exception 'Invalid normalized batch offset' using errcode='22023'; end if;
  for item in select value from public.import_staging s,jsonb_array_elements(s.rows) with ordinality r(value,n) where s.import_id=p_import_id and n>p_offset and n<=p_offset+250 loop
    if (item->>'excluded')::boolean then continue; end if;
    select coalesce(jsonb_agg(candidate),'[]'::jsonb) into candidates from (
      select distinct jsonb_strip_nulls(jsonb_build_object('id',t.id,'status',t.status,'version',t.version,
        'externalId',case when t.posted_on=(item->'row'->>'postedOn')::date and t.amount_minor=(item->'row'->>'amountMinor')::bigint and t.description=item->'row'->>'description' then src.external_id else null end)) candidate
      from public.transactions t
      left join public.transaction_sources link on link.transaction_id=t.id
      left join public.source_transactions src on src.id=link.source_transaction_id
      where t.workspace_id=p_workspace_id and t.account_id=(item->>'accountId')::uuid and t.currency_code=item->'row'->>'currencyCode'
        and (src.id is null or src.import_id<>p_import_id)
        and ((t.posted_on=(item->'row'->>'postedOn')::date and t.amount_minor=(item->'row'->>'amountMinor')::bigint and t.description=item->'row'->>'description')
          or (item->'row'->>'externalId' is not null and src.external_id=item->'row'->>'externalId'))
      limit 1001
    ) bounded;
    if jsonb_array_length(candidates)>1000 then raise exception 'Import candidate limit exceeded; review the overlapping history' using errcode='22023'; end if;
    result:=result||jsonb_build_array(jsonb_build_object('rowNumber',item->'row'->'rowNumber','externalId',item->'row'->'externalId','status',item->'row'->'status','candidates',candidates));
  end loop;
  return result;
end;
$$;

create function public.ingest_import_batch(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_offset integer,p_decisions jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare total integer; item jsonb; decision jsonb; payload jsonb; decisions_count integer:=0;
begin
  if jsonb_typeof(p_decisions) is distinct from 'array' or jsonb_array_length(p_decisions)>250 or octet_length(p_decisions::text)>100000 then raise exception 'Invalid import batch decisions' using errcode='22023'; end if;
  -- Lock all existing canonical targets before the import, preserving correction
  -- lock order even when a retry finds an already linked source.
  perform t.id from public.transactions t where t.workspace_id=p_workspace_id and
    (t.id in(select (value->>'transactionId')::uuid from jsonb_array_elements(p_decisions) where value->>'action'='matched') or
    t.id in(select l.transaction_id from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where s.import_id=p_import_id and s.workspace_id=p_workspace_id and s.row_number>=p_offset+2 and s.row_number<p_offset+252)) order by t.id for update;
  total:=public.read_import_stage(p_import_id,p_workspace_id,p_run_version);
  if total is null or p_offset is null or p_offset<0 or p_offset%250<>0 or p_offset>=total then raise exception 'Invalid normalized batch offset' using errcode='22023'; end if;
  -- Multiple accounts always acquire their overlap locks in the same order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':'||a.id::text,0)) from public.accounts a where a.id in
    (select (value->>'accountId')::uuid from public.import_staging s,jsonb_array_elements(s.rows) with ordinality r(value,n) where s.import_id=p_import_id and n>p_offset and n<=p_offset+250 and not (value->>'excluded')::boolean) order by a.id;
  for item in select value from public.import_staging s,jsonb_array_elements(s.rows) with ordinality r(value,n) where s.import_id=p_import_id and n>p_offset and n<=p_offset+250 loop
    if (item->>'excluded')::boolean then
      perform public.record_import_exclusion(p_import_id,p_workspace_id,p_run_version,item->'row');
    else
      select value into decision from jsonb_array_elements(p_decisions) where (value->>'rowNumber')::integer=(item->'row'->>'rowNumber')::integer;
      if not found or (select count(*) from jsonb_array_elements(p_decisions) where (value->>'rowNumber')::integer=(item->'row'->>'rowNumber')::integer)<>1
        or decision->>'action' is null or decision->>'action' not in ('new','matched','review') then raise exception 'Missing or duplicate batch row decision' using errcode='22023'; end if;
      payload:=item->'row'||jsonb_build_object('action',decision->>'action','transactionId',case when decision->>'action'='matched' then decision->>'transactionId' else public.stable_import_uuid(p_import_id::text||':transaction:'||(item->'row'->>'rowNumber'))::text end,
        'expectedTransactionVersion',decision->'expectedTransactionVersion','reportProgress',false);
      perform public.ingest_import_row(p_import_id,p_workspace_id,p_run_version,(item->>'accountId')::uuid,payload);
      decisions_count:=decisions_count+1;
    end if;
  end loop;
  if decisions_count<>jsonb_array_length(p_decisions) then raise exception 'Unexpected batch row decisions' using errcode='22023'; end if;
  perform public.recount_import_progress(p_import_id);
  return (select jsonb_build_object('newRows',new_rows,'matchedRows',matched_rows,'reviewRows',review_rows,'rejectedRows',rejected_rows) from public.imports where id=p_import_id);
end;
$$;

revoke all on function public.read_import_stage(uuid,uuid,integer),public.stage_import_rows(uuid,uuid,integer,text,jsonb),public.import_batch_candidates(uuid,uuid,integer,integer),public.ingest_import_batch(uuid,uuid,integer,integer,jsonb) from public,anon,authenticated;
grant execute on function public.read_import_stage(uuid,uuid,integer),public.stage_import_rows(uuid,uuid,integer,text,jsonb),public.import_batch_candidates(uuid,uuid,integer,integer),public.ingest_import_batch(uuid,uuid,integer,integer,jsonb) to service_role;
