-- Resolving an ambiguous row and its canonical effect is one database transaction.
alter table public.imports add column rejected_rows integer not null default 0;
revoke insert, update, delete on public.source_transactions from public, authenticated;
revoke insert, update, delete on public.transaction_sources from public, authenticated;

create function public.resolve_import_review(
  p_source_id uuid,
  p_action text,
  p_posted_on date default null,
  p_description text default null,
  p_amount_minor bigint default null,
  p_currency_code text default null
) returns public.source_transactions
language plpgsql security definer set search_path = '' as $$
declare
  source_row public.source_transactions%rowtype;
  import_row public.imports%rowtype;
  account_id uuid;
  transaction_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_action not in ('accept', 'reject') then
    raise exception 'Invalid review action' using errcode = '22023';
  end if;
  select * into source_row from public.source_transactions
  where id = p_source_id and public.owns_workspace(workspace_id) for update;
  if not found then
    raise exception 'Review row not found' using errcode = 'P0002';
  end if;
  if source_row.status in ('accepted', 'rejected') then
    if (p_action = 'accept' and source_row.status = 'accepted') or
       (p_action = 'reject' and source_row.status = 'rejected') then
      return source_row;
    end if;
    raise exception 'Review row already resolved' using errcode = '40001';
  end if;
  if source_row.status <> 'review' then
    raise exception 'Row is not awaiting review' using errcode = '40001';
  end if;
  select * into import_row from public.imports
  where id = source_row.import_id and workspace_id = source_row.workspace_id for update;
  if import_row.status <> 'completed' then
    raise exception 'Import is still processing' using errcode = '40001';
  end if;
  if import_row.review_rows < 1 then
    raise exception 'Import review count is inconsistent' using errcode = '40001';
  end if;
  if p_action = 'accept' then
    if p_posted_on is null or nullif(btrim(p_description), '') is null or
       length(p_description) > 500 or p_amount_minor is null or
       p_currency_code is null or p_currency_code !~ '^[A-Z]{3}$' then
      raise exception 'Invalid transaction values' using errcode = '22023';
    end if;
    select ds.account_id into account_id from public.data_sources ds
    where ds.id = import_row.source_id and ds.workspace_id = source_row.workspace_id;
    if account_id is null then
      raise exception 'Import account unavailable' using errcode = 'P0002';
    end if;
    insert into public.transactions (workspace_id, account_id, posted_on, description, amount_minor, currency_code)
    values (source_row.workspace_id, account_id, p_posted_on, btrim(p_description), p_amount_minor, p_currency_code)
    returning id into transaction_id;
    insert into public.transaction_sources (transaction_id, source_transaction_id)
    values (transaction_id, source_row.id);
    update public.imports set new_rows = new_rows + 1, review_rows = review_rows - 1
    where id = import_row.id;
    update public.source_transactions set status = 'accepted' where id = source_row.id returning * into source_row;
  else
    update public.imports set review_rows = review_rows - 1, rejected_rows = rejected_rows + 1
    where id = import_row.id;
    update public.source_transactions set status = 'rejected' where id = source_row.id returning * into source_row;
  end if;
  return source_row;
end;
$$;

revoke all on function public.resolve_import_review(uuid, text, date, text, bigint, text) from public;
grant execute on function public.resolve_import_review(uuid, text, date, text, bigint, text) to authenticated;
