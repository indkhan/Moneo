-- Reviewed exclusions preserve original observations and participate in normal
-- progress, cancellation, retry and undo boundaries without creating ledger rows.
alter table public.source_transactions drop constraint source_transactions_review_reasons_check;
alter table public.source_transactions add constraint source_transactions_review_reasons_check check
  (review_reasons <@ array['source_transfer','source_exchange','source_type','refund_sign','fee_semantics','excluded_by_review']::text[]);

create function public.record_import_exclusion(p_import_id uuid,p_workspace_id uuid,p_run_version integer,p_row jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; source public.source_transactions%rowtype; source_id uuid; row_number integer;
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
  select * into strict source from public.source_transactions where id=source_id;
  if source.workspace_id is distinct from p_workspace_id or source.import_id is distinct from p_import_id
    or source.row_number is distinct from row_number or source.original_row is distinct from p_row->'originalRow'
    or source.status is distinct from 'rejected' or source.review_reasons is distinct from array['excluded_by_review']::text[]
    or exists(select 1 from public.transaction_sources where source_transaction_id=source_id) then
    raise exception 'Excluded source identity changed' using errcode='22023';
  end if;
  perform public.recount_import_progress(p_import_id);
end;
$$;
revoke all on function public.record_import_exclusion(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.record_import_exclusion(uuid,uuid,integer,jsonb) to service_role;
