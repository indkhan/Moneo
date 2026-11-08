-- Banks without transaction IDs repeat rows on every overlapping sync. A bank's answer is complete for the dates it
-- covers, so identical rows can be compared by how many there are: n identical rows the bank states against n canonical
-- ledger rows are repeats, and one more is a genuine second payment. mapping.completeWindow marks an import that came
-- from such an answer; a file has no such promise, so its overlaps still go to review.
create or replace function public.import_batch_candidates(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_offset integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare total integer; item jsonb; candidates jsonb; result jsonb:='[]'::jsonb; occurrences jsonb:='{}'::jsonb;
begin
  total:=public.read_import_stage(p_import_id,p_workspace_id,p_run_version);
  if total is null or p_offset is null or p_offset<0 or p_offset%250<>0 or p_offset>=total then raise exception 'Invalid normalized batch offset' using errcode='22023'; end if;
  if (select (mapping->>'completeWindow')::boolean from public.imports where id=p_import_id) then
    select coalesce(jsonb_object_agg(rank.row_number,jsonb_build_object('index',rank.position,'total',rank.identical)),'{}'::jsonb) into occurrences from (
      select r.value->'row'->>'rowNumber' row_number,
        row_number() over identical position, count(*) over identical identical
      from public.import_staging s,jsonb_array_elements(s.rows) r
      where s.import_id=p_import_id and not (r.value->>'excluded')::boolean and r.value->'row'->>'externalId' is null
      window identical as (partition by r.value->>'accountId',r.value->'row'->>'currencyCode',r.value->'row'->>'postedOn',r.value->'row'->>'amountMinor',r.value->'row'->>'description' order by (r.value->'row'->>'rowNumber')::integer rows between unbounded preceding and unbounded following)
    ) rank;
  end if;
  for item in select value from public.import_staging s,jsonb_array_elements(s.rows) with ordinality r(value,n) where s.import_id=p_import_id and n>p_offset and n<=p_offset+250 loop
    if (item->>'excluded')::boolean then continue; end if;
    select coalesce(jsonb_agg(candidate),'[]'::jsonb) into candidates from (
      -- Separate equality paths let PostgreSQL use each candidate index. An
      -- OR with a correlated source lookup otherwise scans all account history
      -- for every row once PL/pgSQL chooses a generic cached plan.
      select distinct candidate from (
        select jsonb_build_object('id',t.id,'status',t.status,'version',t.version,
          'stableExternalMatch',coalesce(src.external_id=item->'row'->>'externalId',false)) candidate
        from public.transactions t
        left join public.transaction_sources link on link.transaction_id=t.id
        left join public.source_transactions src on src.id=link.source_transaction_id
        where t.workspace_id=p_workspace_id and t.account_id=(item->>'accountId')::uuid and t.currency_code=item->'row'->>'currencyCode'
          and t.posted_on=(item->'row'->>'postedOn')::date and t.amount_minor=(item->'row'->>'amountMinor')::bigint and t.description=item->'row'->>'description'
          and (src.id is null or (src.workspace_id=p_workspace_id and src.import_id<>p_import_id))
        union all
        select jsonb_build_object('id',t.id,'status',t.status,'version',t.version,
          'stableExternalMatch',t.posted_on=(item->'row'->>'postedOn')::date and t.amount_minor=(item->'row'->>'amountMinor')::bigint and t.description=item->'row'->>'description') candidate
        from public.source_transactions src
        join public.transaction_sources link on link.source_transaction_id=src.id
        join public.transactions t on t.id=link.transaction_id
        where src.workspace_id=p_workspace_id and src.import_id<>p_import_id and src.external_id=item->'row'->>'externalId'
          and t.workspace_id=p_workspace_id and t.account_id=(item->>'accountId')::uuid and t.currency_code=item->'row'->>'currencyCode'
      ) indexed_candidates
      limit 1001
    ) bounded;
    if jsonb_array_length(candidates)>1000 then raise exception 'Import candidate limit exceeded; review the overlapping history' using errcode='22023'; end if;
    result:=result||jsonb_build_array(jsonb_build_object('rowNumber',item->'row'->'rowNumber','hasExternalId',item->'row'->>'externalId' is not null,'status',item->'row'->'status','candidates',candidates)
      ||case when occurrences ? (item->'row'->>'rowNumber') then jsonb_build_object('occurrence',occurrences->(item->'row'->>'rowNumber')) else '{}'::jsonb end);
  end loop;
  return result;
end;
$$;

create or replace function public.ingest_import_batch(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_offset integer,p_decisions jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare total integer; item jsonb; decision jsonb; payload jsonb; decisions_count integer:=0; complete_window boolean; by_occurrence boolean;
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
  perform public.recount_import_progress(p_import_id);
  return (select jsonb_build_object('newRows',new_rows,'matchedRows',matched_rows,'reviewRows',review_rows,'rejectedRows',rejected_rows) from public.imports where id=p_import_id);
end;
$$;

-- The row-level guards above already hold for byOccurrence, which only ingest_import_batch sets: a matched row needs no
-- external ID, and a new row may share its fingerprint with the canonical rows it was counted against.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.ingest_import_row_internal(uuid,uuid,integer,uuid,jsonb,boolean)'::regprocedure);
  if position('      or p_row->>''externalId'' is null or not exists(' in definition)=0 or position('t.status=p_row->>''status'')<>1 then raise exception ''Import match changed' in definition)=0
    or position('    if not p_review and exists(select 1 from public.transactions t where t.workspace_id=p_workspace_id and t.account_id=p_account_id' in definition)=0 then raise exception 'Expected import guards absent'; end if;
  definition:=replace(definition,'      or p_row->>''externalId'' is null or not exists(','      or (not coalesce((p_row->>''byOccurrence'')::boolean,false) and (p_row->>''externalId'' is null or not exists(');
  definition:=replace(definition,'t.status=p_row->>''status'')<>1 then raise exception ''Import match changed','t.status=p_row->>''status'')<>1)) then raise exception ''Import match changed');
  definition:=replace(definition,'    if not p_review and exists(select 1 from public.transactions t where t.workspace_id=p_workspace_id and t.account_id=p_account_id',
    '    if not p_review and not coalesce((p_row->>''byOccurrence'')::boolean,false) and exists(select 1 from public.transactions t where t.workspace_id=p_workspace_id and t.account_id=p_account_id');
  execute definition;
end;
$$;
