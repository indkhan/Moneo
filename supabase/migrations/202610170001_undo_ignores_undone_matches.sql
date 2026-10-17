-- An undone re-import keeps its matched links as evidence, but those links no longer
-- make the original import's transactions shared. Without this, undoing a duplicate
-- re-import (e.g. a repeated bank sync) left the original import permanently un-undoable.
-- Same bodies as the live definitions plus the undone-import filter and stale-link cleanup.

CREATE OR REPLACE FUNCTION public.preview_import_undo(p_import_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  import_row public.imports%rowtype;
  txn_ids uuid[] := '{}';
  deletable_txn integer := 0;
  deletable_bal integer := 0;
  blockers text[] := '{}';
  corrected integer := 0;
  recurring integer := 0;
  linked integer := 0;
  referenced integer := 0;
  shared integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into import_row from public.imports
  where id = p_import_id and public.owns_workspace(workspace_id);
  if not found then
    raise exception 'Import not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(ts.transaction_id), '{}'::uuid[]) into txn_ids
  from public.transaction_sources ts
  join public.source_transactions st on st.id = ts.source_transaction_id
  where st.import_id = p_import_id
    and st.workspace_id = import_row.workspace_id
    and st.status in ('new', 'accepted');
  deletable_txn := coalesce(array_length(txn_ids, 1), 0);

  select count(*)::integer into deletable_bal from public.balance_snapshots
  where workspace_id = import_row.workspace_id
    and provenance like 'import:' || p_import_id::text || ':%';

  if import_row.status = 'undone' then
    blockers := blockers || 'Import is already undone';
  elsif import_row.status in ('queued', 'running', 'pending') then
    blockers := blockers || 'Import is still processing';
  elsif import_row.status <> 'completed' then
    blockers := blockers || 'Only completed imports can be undone';
  end if;

  if import_row.review_rows > 0 then
    blockers := blockers || format('%s rows still need review; resolve or reject them first', import_row.review_rows);
  end if;

  if deletable_txn > 0 then
    select count(*)::integer into corrected from public.correction_events
    where transaction_id = any (txn_ids);
    if corrected > 0 then
      blockers := blockers || format('%s transactions have corrections and cannot be undone safely', corrected);
    end if;

    select count(*)::integer into recurring from public.recurring_series_transactions
    where transaction_id = any (txn_ids);
    if recurring > 0 then
      blockers := blockers || format('%s transactions are used as recurring evidence', recurring);
    end if;

    select count(*)::integer into linked from public.transactions
    where id = any (txn_ids) and (transfer_id is not null or refund_of_id is not null);
    if linked > 0 then
      blockers := blockers || format('%s transactions are linked as transfers or refunds', linked);
    end if;

    select count(*)::integer into referenced from public.transactions
    where refund_of_id = any (txn_ids) or transfer_id = any (txn_ids);
    if referenced > 0 then
      blockers := blockers || format('%s other transactions reference these transactions', referenced);
    end if;

    select count(*)::integer into shared from (
      select ts.transaction_id from public.transaction_sources ts
      join public.source_transactions st on st.id = ts.source_transaction_id
      left join public.imports i on i.id = st.import_id
      where ts.transaction_id = any (txn_ids) and i.status is distinct from 'undone'
      group by ts.transaction_id having count(*) > 1
    ) s;
    if shared > 0 then
      blockers := blockers || format('%s transactions are also referenced by another import', shared);
    end if;
  end if;

  if exists(select 1 from public.pending_hold_resolutions where undone_at is null and (pending_transaction_id=any(txn_ids) or posted_transaction_id=any(txn_ids))) then
    blockers:=array_append(blockers,'Undo pending hold resolutions before undoing this import');
  end if;
  return jsonb_build_object(
    'import_id', import_row.id,
    'filename', import_row.filename,
    'status', import_row.status,
    'total_rows', import_row.total_rows,
    'new_rows', import_row.new_rows,
    'matched_rows', import_row.matched_rows,
    'review_rows', import_row.review_rows,
    'rejected_rows', import_row.rejected_rows,
    'deletable_transactions', deletable_txn,
    'deletable_balances', deletable_bal,
    'blockers', to_jsonb(blockers),
    'safe', (array_length(blockers, 1) is null)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.undo_import_before_control(p_import_id uuid, p_expected_transactions integer, p_expected_balances integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  import_row public.imports%rowtype;
  txn_ids uuid[] := '{}';
  deletable_txn integer := 0;
  deletable_bal integer := 0;
  corrected integer := 0;
  recurring integer := 0;
  linked integer := 0;
  referenced integer := 0;
  shared integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_expected_transactions is null or p_expected_transactions < 0
     or p_expected_balances is null or p_expected_balances < 0 then
    raise exception 'Invalid confirmation counts' using errcode = '22023';
  end if;

  select * into import_row from public.imports
  where id = p_import_id and public.owns_workspace(workspace_id)
  for update;
  if not found then
    raise exception 'Import not found' using errcode = 'P0002';
  end if;

  if import_row.status = 'undone' then
    return jsonb_build_object('import_id', import_row.id, 'status', 'undone',
      'undone_transactions', 0, 'undone_balances', 0);
  end if;
  if import_row.status in ('queued', 'running', 'pending') then
    raise exception 'Import is still processing' using errcode = '40001';
  end if;
  if import_row.status <> 'completed' then
    raise exception 'Only completed imports can be undone' using errcode = '40001';
  end if;
  if import_row.review_rows > 0 then
    raise exception 'Import has % rows still needing review', import_row.review_rows using errcode = '40001';
  end if;

  select coalesce(array_agg(ts.transaction_id), '{}'::uuid[]) into txn_ids
  from public.transaction_sources ts
  join public.source_transactions st on st.id = ts.source_transaction_id
  where st.import_id = p_import_id
    and st.workspace_id = import_row.workspace_id
    and st.status in ('new', 'accepted');
  deletable_txn := coalesce(array_length(txn_ids, 1), 0);

  select count(*)::integer into deletable_bal from public.balance_snapshots
  where workspace_id = import_row.workspace_id
    and provenance like 'import:' || p_import_id::text || ':%';

  if deletable_txn is distinct from p_expected_transactions
     or deletable_bal is distinct from p_expected_balances then
    raise exception 'Import changed; refresh the preview and confirm again' using errcode = '40001';
  end if;

  if deletable_txn > 0 then
    perform 1 from public.transactions
    where id = any (txn_ids) and workspace_id = import_row.workspace_id
    for update;

    select count(*)::integer into corrected from public.correction_events
    where transaction_id = any (txn_ids);
    if corrected > 0 then
      raise exception '% transactions have corrections and cannot be undone safely', corrected using errcode = '40001';
    end if;

    select count(*)::integer into recurring from public.recurring_series_transactions
    where transaction_id = any (txn_ids);
    if recurring > 0 then
      raise exception '% transactions are used as recurring evidence', recurring using errcode = '40001';
    end if;

    select count(*)::integer into linked from public.transactions
    where id = any (txn_ids) and (transfer_id is not null or refund_of_id is not null);
    if linked > 0 then
      raise exception '% transactions are linked as transfers or refunds', linked using errcode = '40001';
    end if;

    select count(*)::integer into referenced from public.transactions
    where refund_of_id = any (txn_ids) or transfer_id = any (txn_ids);
    if referenced > 0 then
      raise exception '% other transactions reference these transactions', referenced using errcode = '40001';
    end if;

    select count(*)::integer into shared from (
      select ts.transaction_id from public.transaction_sources ts
      join public.source_transactions st on st.id = ts.source_transaction_id
      left join public.imports i on i.id = st.import_id
      where ts.transaction_id = any (txn_ids) and i.status is distinct from 'undone'
      group by ts.transaction_id having count(*) > 1
    ) s;
    if shared > 0 then
      raise exception '% transactions are also referenced by another import', shared using errcode = '40001';
    end if;
  end if;

  delete from public.transaction_sources ts
  using public.source_transactions st
  where ts.source_transaction_id = st.id
    and st.import_id = p_import_id
    and st.workspace_id = import_row.workspace_id
    and st.status in ('new', 'accepted');

  delete from public.balance_snapshots
  where workspace_id = import_row.workspace_id
    and provenance like 'import:' || p_import_id::text || ':%';

  -- Matched links kept by an already-undone duplicate import no longer hold these transactions.
  delete from public.transaction_sources ts
  using public.source_transactions st, public.imports i
  where ts.source_transaction_id = st.id and i.id = st.import_id
    and i.status = 'undone' and ts.transaction_id = any (txn_ids);

  if deletable_txn > 0 then
    delete from public.transactions
    where id = any (txn_ids) and workspace_id = import_row.workspace_id;
  end if;

  update public.source_transactions set status = 'undone'
  where import_id = p_import_id
    and workspace_id = import_row.workspace_id
    and status in ('new', 'accepted');

  update public.imports set status = 'undone', undone_at = now(), undone_by = auth.uid()
  where id = p_import_id and workspace_id = import_row.workspace_id;

  return jsonb_build_object('import_id', import_row.id, 'status', 'undone',
    'undone_transactions', deletable_txn, 'undone_balances', deletable_bal);
end;
$function$;
