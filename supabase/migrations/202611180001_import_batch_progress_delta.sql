-- A batch changes only its own source rows, so it adds their change to the import's counts instead of recounting every row already ingested.
-- finish_import_run, undo and review corrections still recount the whole import.
create function public.import_rows_progress(p_import_id uuid,p_first_row integer,p_last_row integer)
returns table(new_rows integer,matched_rows integer,review_rows integer,rejected_rows integer,classification_review_rows integer)
language sql stable security definer set search_path='' as $$
  select (count(*) filter (where s.status in ('new','accepted') and l.source_transaction_id is not null))::integer,
    (count(*) filter (where s.status='matched' and l.source_transaction_id is not null))::integer,
    (count(*) filter (where s.status='review'))::integer,
    (count(*) filter (where s.status='rejected'))::integer,
    (count(*) filter (where cardinality(t.review_reasons)>0))::integer
  from public.source_transactions s
  left join public.transaction_sources l on l.source_transaction_id=s.id
  left join public.transactions t on t.id=l.transaction_id
  where s.import_id=p_import_id and s.row_number between p_first_row and p_last_row
$$;
revoke all on function public.import_rows_progress(uuid,integer,integer) from public,anon,authenticated;

create or replace function public.record_import_exclusion(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_row jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; source public.source_transactions%rowtype; source_id uuid; row_number integer; inserted integer;
begin
  imported:=public.lock_import_run(p_import_id,p_workspace_id,p_run_version);
  -- A 10 MB original file may expand up to sixfold when JSON escapes control
  -- characters. Preserve that evidence even when it cannot enter the ledger RPC.
  if p_row is null or jsonb_typeof(p_row) is distinct from 'object' or octet_length(p_row::text)>64000000 then
    raise exception 'Invalid excluded source observation' using errcode='22023';
  end if;
  source_id:=(p_row->>'sourceId')::uuid;
  row_number:=(p_row->>'rowNumber')::integer;
  if source_id is null or row_number is null or row_number<2 or row_number>imported.total_rows+1
    or jsonb_typeof(p_row->'originalRow') is distinct from 'object' or nullif(btrim(p_row->>'reason'),'') is null
    or length(p_row->>'reason')>500 or imported.mapping->>'rowContractVersion' is distinct from 'normalized-row-v1'
    or not exists(select 1 from jsonb_array_elements(imported.mapping->'rowDecisions') decision
      where decision->>'action'='exclude' and (decision->>'rowNumber')::integer=row_number and decision->>'reason'=p_row->>'reason') then
    raise exception 'Source exclusion differs from reviewed interpretation' using errcode='22023';
  end if;
  insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status,review_reasons)
    values(source_id,p_workspace_id,p_import_id,row_number,p_row->'originalRow','rejected',array['excluded_by_review']) on conflict(id) do nothing;
  get diagnostics inserted=row_count;
  select * into strict source from public.source_transactions where id=source_id;
  if source.workspace_id is distinct from p_workspace_id or source.import_id is distinct from p_import_id
    or source.row_number is distinct from row_number or source.original_row is distinct from p_row->'originalRow'
    or source.status is distinct from 'rejected' or source.review_reasons is distinct from array['excluded_by_review']::text[]
    or exists(select 1 from public.transaction_sources where source_transaction_id=source_id) then
    raise exception 'Excluded source identity changed' using errcode='22023';
  end if;
  update public.imports set rejected_rows=rejected_rows+inserted where id=p_import_id;
end;
$$;

create or replace function public.ingest_import_batch(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_offset integer,p_decisions jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare total integer; item jsonb; decision jsonb; payload jsonb; decisions_count integer:=0; complete_window boolean; by_occurrence boolean;
  imported public.imports%rowtype; before_batch record; after_batch record;
begin
  if jsonb_typeof(p_decisions) is distinct from 'array' or jsonb_array_length(p_decisions)>250 or octet_length(p_decisions::text)>100000 then raise exception 'Invalid import batch decisions' using errcode='22023'; end if;
  -- Lock all existing canonical targets before the import, preserving correction
  -- lock order even when a retry finds an already linked source.
  perform t.id from public.transactions t where t.workspace_id=p_workspace_id and
    (t.id in(select (value->>'transactionId')::uuid from jsonb_array_elements(p_decisions) where value->>'action'='matched') or
    t.id in(select l.transaction_id from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where s.import_id=p_import_id and s.workspace_id=p_workspace_id and s.row_number>=p_offset+2 and s.row_number<p_offset+252)) order by t.id for update;
  total:=public.read_import_stage(p_import_id,p_workspace_id,p_run_version);
  if total is null or p_offset is null or p_offset<0 or p_offset%250<>0 or p_offset>=total then raise exception 'Invalid normalized batch offset' using errcode='22023'; end if;
  complete_window:=coalesce((select (mapping->>'completeWindow')::boolean from public.imports where id=p_import_id),false);
  -- Multiple accounts always acquire their overlap locks in the same order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':'||a.id::text,0)) from public.accounts a where a.id in
    (select (value->>'accountId')::uuid from public.import_staging s,jsonb_array_elements(s.rows) with ordinality r(value,n) where s.import_id=p_import_id and n>p_offset and n<=p_offset+250 and not (value->>'excluded')::boolean) order by a.id;
  -- read_import_stage holds the import row lock until commit, so the totals read here and written below cannot interleave with another batch.
  select * into strict imported from public.imports where id=p_import_id;
  select * into strict before_batch from public.import_rows_progress(p_import_id,p_offset+2,p_offset+251);
  for item in select value from public.import_staging s,jsonb_array_elements(s.rows) with ordinality r(value,n) where s.import_id=p_import_id and n>p_offset and n<=p_offset+250 loop
    if (item->>'excluded')::boolean then
      perform public.record_import_exclusion(p_import_id,p_workspace_id,p_run_version,item->'row');
    else
      select value into decision from jsonb_array_elements(p_decisions) where (value->>'rowNumber')::integer=(item->'row'->>'rowNumber')::integer;
      if not found or (select count(*) from jsonb_array_elements(p_decisions) where (value->>'rowNumber')::integer=(item->'row'->>'rowNumber')::integer)<>1
        or decision->>'action' is null or decision->>'action' not in ('new','matched','review') then raise exception 'Missing or duplicate batch row decision' using errcode='22023'; end if;
      by_occurrence:=decision->>'occurrenceIndex' is not null;
      if by_occurrence then
        if not complete_window or item->'row'->>'externalId' is not null or decision->>'action'='review' then raise exception 'Occurrence evidence needs a complete bank window' using errcode='22023'; end if;
        -- A second identical payment lands only while there are fewer canonical rows than the bank states; otherwise re-read.
        if decision->>'action'='new' and (select count(*) from public.transactions t where t.workspace_id=p_workspace_id and t.account_id=(item->>'accountId')::uuid and t.currency_code=item->'row'->>'currencyCode'
          and t.posted_on=(item->'row'->>'postedOn')::date and t.amount_minor=(item->'row'->>'amountMinor')::bigint and t.description=item->'row'->>'description' and t.status=item->'row'->>'status'
          and not exists(select 1 from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where l.transaction_id=t.id and s.import_id=p_import_id))>=(decision->>'occurrenceIndex')::integer
        then raise exception 'Import candidates changed; retry with current evidence' using errcode='PT409'; end if;
      end if;
      payload:=item->'row'||jsonb_build_object('action',decision->>'action','transactionId',case when decision->>'action'='matched' then decision->>'transactionId' else public.stable_import_uuid(p_import_id::text||':transaction:'||(item->'row'->>'rowNumber'))::text end,
        'expectedTransactionVersion',decision->'expectedTransactionVersion','reportProgress',false)||case when by_occurrence then '{"byOccurrence":true}'::jsonb else '{}'::jsonb end;
      perform public.ingest_import_row(p_import_id,p_workspace_id,p_run_version,(item->>'accountId')::uuid,payload);
      decisions_count:=decisions_count+1;
    end if;
  end loop;
  if decisions_count<>jsonb_array_length(p_decisions) then raise exception 'Unexpected batch row decisions' using errcode='22023'; end if;
  select * into strict after_batch from public.import_rows_progress(p_import_id,p_offset+2,p_offset+251);
  update public.imports set new_rows=imported.new_rows-before_batch.new_rows+after_batch.new_rows,
    matched_rows=imported.matched_rows-before_batch.matched_rows+after_batch.matched_rows,
    review_rows=imported.review_rows-before_batch.review_rows+after_batch.review_rows,
    rejected_rows=imported.rejected_rows-before_batch.rejected_rows+after_batch.rejected_rows,
    classification_review_rows=imported.classification_review_rows-before_batch.classification_review_rows+after_batch.classification_review_rows
    where id=p_import_id;
  return (select jsonb_build_object('newRows',new_rows,'matchedRows',matched_rows,'reviewRows',review_rows,'rejectedRows',rejected_rows) from public.imports where id=p_import_id);
end;
$$;
