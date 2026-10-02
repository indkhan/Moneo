-- Classification uncertainty is separate from overlap review: preserve valid booked money.
alter table public.transactions add column review_reasons text[] not null default '{}';
alter table public.source_transactions add column review_reasons text[] not null default '{}';
alter table public.imports add column classification_review_rows integer not null default 0;
alter table public.transactions add constraint transactions_review_reasons_check check
  (review_reasons <@ array['source_transfer','source_exchange','source_type','refund_sign','fee_semantics']::text[]);
alter table public.source_transactions add constraint source_transactions_review_reasons_check check
  (review_reasons <@ array['source_transfer','source_exchange','source_type','refund_sign','fee_semantics']::text[]);
alter table public.imports add constraint imports_classification_review_rows_check check (classification_review_rows >= 0);

create function public.recount_import_progress(p_import_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Direct execution is service-role-only; owner-scoped review RPCs may call it internally.
  if not exists (select 1 from public.imports i where i.id = p_import_id) then
    raise exception 'Import not found' using errcode = 'P0002';
  end if;
  update public.imports i set
    new_rows = (select count(*) from public.source_transactions s where s.import_id = i.id and s.status in ('new','accepted')
      and exists (select 1 from public.transaction_sources l where l.source_transaction_id = s.id)),
    matched_rows = (select count(*) from public.source_transactions s where s.import_id = i.id and s.status = 'matched'
      and exists (select 1 from public.transaction_sources l where l.source_transaction_id = s.id)),
    review_rows = (select count(*) from public.source_transactions s where s.import_id = i.id and s.status = 'review'),
    rejected_rows = (select count(*) from public.source_transactions s where s.import_id = i.id and s.status = 'rejected'),
    classification_review_rows = (select count(*) from public.source_transactions s
      join public.transaction_sources l on l.source_transaction_id = s.id
      join public.transactions t on t.id = l.transaction_id
      where s.import_id = i.id and cardinality(t.review_reasons) > 0)
  where i.id = p_import_id;
end;
$$;
revoke all on function public.recount_import_progress(uuid) from public, authenticated;
grant execute on function public.recount_import_progress(uuid) to service_role;

create function public.resolve_transaction_classification(
  p_transaction_id uuid, p_expected_version integer, p_kind text, p_fee_included boolean default false
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  old_row public.transactions%rowtype;
  new_row public.transactions%rowtype;
  event_id uuid;
  imported_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_expected_version is null or p_expected_version < 0 then raise exception 'Expected version required' using errcode = '22023'; end if;
  select * into old_row from public.transactions where id = p_transaction_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Transaction not found' using errcode = 'P0002'; end if;
  if old_row.version is distinct from p_expected_version then raise exception 'Transaction changed; refresh and retry' using errcode = '40001'; end if;
  if cardinality(old_row.review_reasons) = 0 then raise exception 'Classification already reviewed' using errcode = '40001'; end if;
  if p_kind not in ('ordinary','refund','transfer') or p_kind is null then raise exception 'Invalid classification' using errcode = '22023'; end if;
  if p_kind = 'transfer' and old_row.transfer_id is null then raise exception 'Link the internal transfer first' using errcode = '22023'; end if;
  if p_kind = 'refund' and old_row.amount_minor <= 0 then raise exception 'A refund must be a positive booked credit' using errcode = '22023'; end if;
  if p_kind <> 'transfer' and old_row.transfer_id is not null then raise exception 'Clear the transfer link first' using errcode = '22023'; end if;
  if p_kind <> 'refund' and old_row.refund_of_id is not null then raise exception 'Clear the refund link first' using errcode = '22023'; end if;
  if 'fee_semantics' = any(old_row.review_reasons) and p_fee_included is not true then
    raise exception 'Verify the booked amount includes the source fee; separate or unknown fees remain under review' using errcode = '22023';
  end if;
  update public.transactions set kind = p_kind, review_reasons = '{}', version = version + 1 where id = old_row.id returning * into new_row;
  insert into public.correction_events(workspace_id, transaction_id, actor_id, before, after)
    values(old_row.workspace_id, old_row.id, auth.uid(),
      jsonb_build_object('kind',old_row.kind,'review_reasons',old_row.review_reasons,'version',old_row.version),
      jsonb_build_object('kind',new_row.kind,'review_reasons',new_row.review_reasons,'version',new_row.version,'operation','classification_review','fee_included',p_fee_included))
    returning id into event_id;
  for imported_id in select distinct s.import_id from public.source_transactions s join public.transaction_sources l on l.source_transaction_id = s.id where l.transaction_id = old_row.id loop
    perform public.recount_import_progress(imported_id);
  end loop;
  return jsonb_build_object('eventId',event_id,'version',new_row.version);
end;
$$;

create function public.undo_transaction_classification(p_event_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  event_row public.correction_events%rowtype;
  transaction_row public.transactions%rowtype;
  imported_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_expected_version is null or p_expected_version < 0 then raise exception 'Expected version required' using errcode = '22023'; end if;
  select * into event_row from public.correction_events where id = p_event_id and public.owns_workspace(workspace_id);
  if not found or event_row.undone or event_row.after->>'operation' is distinct from 'classification_review' then
    raise exception 'Classification review not found' using errcode = 'P0002';
  end if;
  select * into transaction_row from public.transactions where id = event_row.transaction_id and workspace_id = event_row.workspace_id for update;
  if transaction_row.version is distinct from p_expected_version or
      transaction_row.kind is distinct from event_row.after->>'kind' or
      to_jsonb(transaction_row.review_reasons) is distinct from event_row.after->'review_reasons' or
      exists(select 1 from public.correction_events newer where newer.transaction_id = transaction_row.id and not newer.undone and
        (newer.after->>'version')::integer > (event_row.after->>'version')::integer) then
    raise exception 'Transaction changed; only the latest review can be undone' using errcode = '40001';
  end if;
  update public.transactions set kind = event_row.before->>'kind',
    review_reasons = array(select jsonb_array_elements_text(event_row.before->'review_reasons')),
    version = version + 1 where id = transaction_row.id returning * into transaction_row;
  update public.correction_events set undone = true where id = event_row.id;
  for imported_id in select distinct s.import_id from public.source_transactions s join public.transaction_sources l on l.source_transaction_id = s.id where l.transaction_id = transaction_row.id loop
    perform public.recount_import_progress(imported_id);
  end loop;
  return jsonb_build_object('version',transaction_row.version);
end;
$$;
revoke all on function public.resolve_transaction_classification(uuid,integer,text,boolean) from public;
revoke all on function public.undo_transaction_classification(uuid,integer) from public;
grant execute on function public.resolve_transaction_classification(uuid,integer,text,boolean) to authenticated;
grant execute on function public.undo_transaction_classification(uuid,integer) to authenticated;

-- Preserve classification evidence when an overlap is explicitly accepted as new.
alter function public.resolve_import_review(uuid,text,date,text,bigint,text) rename to resolve_import_review_before_classification;
revoke all on function public.resolve_import_review_before_classification(uuid,text,date,text,bigint,text) from public, authenticated;
create function public.resolve_import_review(p_source_id uuid,p_action text,p_posted_on date default null,p_description text default null,p_amount_minor bigint default null,p_currency_code text default null)
returns public.source_transactions language plpgsql security definer set search_path = '' as $$
declare source_row public.source_transactions%rowtype; prior_status text; mapping jsonb; type_column text; source_type text;
begin
  select status into prior_status from public.source_transactions where id = p_source_id and public.owns_workspace(workspace_id) for update;
  source_row := public.resolve_import_review_before_classification(p_source_id,p_action,p_posted_on,p_description,p_amount_minor,p_currency_code);
  if prior_status = 'review' and source_row.status = 'accepted' then
    select i.mapping into mapping from public.imports i where i.id = source_row.import_id;
    type_column := mapping->>'typeColumn';
    if type_column is null then select key into type_column from jsonb_each(source_row.original_row) where lower(btrim(key)) = 'type'; end if;
    source_type := lower(btrim(source_row.original_row->>type_column));
    update public.transactions t set review_reasons = source_row.review_reasons,
      kind = case when source_type = 'card refund' and t.amount_minor > 0 then 'refund' else 'ordinary' end
    from public.transaction_sources l where l.source_transaction_id = source_row.id and t.id = l.transaction_id;
  end if;
  perform public.recount_import_progress(source_row.import_id);
  return source_row;
end;
$$;
revoke all on function public.resolve_import_review(uuid,text,date,text,bigint,text) from public;
grant execute on function public.resolve_import_review(uuid,text,date,text,bigint,text) to authenticated;

-- Older imports retain their evidence. Surface interpretation gaps without deleting booked rows.
with evidence as (
  select s.id,
    lower(btrim(coalesce(s.original_row->>(i.mapping->>'typeColumn'),
      (select value #>> '{}' from jsonb_each(s.original_row) where lower(btrim(key)) = 'type')))) as source_type,
    btrim(coalesce(s.original_row->>(i.mapping->>'feeColumn'),
      (select value #>> '{}' from jsonb_each(s.original_row) where lower(btrim(key)) = 'fee'))) as source_fee,
    t.amount_minor
  from public.source_transactions s join public.imports i on i.id = s.import_id
    left join public.transaction_sources l on l.source_transaction_id = s.id
    left join public.transactions t on t.id = l.transaction_id
)
update public.source_transactions s set review_reasons = array_remove(array[
  case when e.source_type = 'transfer' then 'source_transfer'
    when e.source_type = 'exchange' then 'source_exchange'
    when e.source_type = 'card refund' and e.amount_minor <= 0 then 'refund_sign'
    when nullif(e.source_type,'') is not null and e.source_type not in ('transfer','exchange','card refund','card payment') then 'source_type' end,
  case when nullif(e.source_fee,'') is not null and e.source_fee !~ '^[+-]?0+([.,]0+)?$' then 'fee_semantics' end
]::text[],null) from evidence e where e.id = s.id;

update public.transactions t set review_reasons = coalesce((
  select array_agg(distinct reason) from public.transaction_sources l
    join public.source_transactions s on s.id = l.source_transaction_id,
    unnest(s.review_reasons) reason
  where l.transaction_id = t.id and (t.kind = 'ordinary' or reason = 'fee_semantics')
),'{}'::text[]) where exists(select 1 from public.transaction_sources l where l.transaction_id = t.id);

update public.transactions t set kind = 'refund'
where t.kind = 'ordinary' and t.version = 0 and t.amount_minor > 0 and exists (
  select 1 from public.transaction_sources l join public.source_transactions s on s.id = l.source_transaction_id
    join public.imports i on i.id = s.import_id
  where l.transaction_id = t.id and lower(btrim(coalesce(s.original_row->>(i.mapping->>'typeColumn'),
    (select value #>> '{}' from jsonb_each(s.original_row) where lower(btrim(key)) = 'type')))) = 'card refund'
);
do $$ declare imported_id uuid; begin
  for imported_id in select id from public.imports loop perform public.recount_import_progress(imported_id); end loop;
end $$;
