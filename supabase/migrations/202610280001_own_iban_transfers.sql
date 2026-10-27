-- One leg whose counterparty IBAN is one of the owner's tracked accounts, when the other leg
-- is not in Moneo (for example history from before that account was imported). Same audit
-- and undo as mark_own_account_transfer: the correction event uses the same operation, so
-- undo_own_account_transfer restores it exactly.
create function public.mark_own_iban_transfer(
  p_transaction_id uuid,
  p_expected_version integer,
  p_iban text
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  old_row public.transactions%rowtype;
  new_row public.transactions%rowtype;
  own_label text;
begin
  if auth.uid() is null and (select auth.jwt()->>'role') is distinct from 'service_role' then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into old_row from public.transactions
  where id = p_transaction_id and public.can_link_workspace(workspace_id) for update;
  if not found then raise exception 'Transaction not found' using errcode = 'P0002'; end if;
  actor := public.link_actor(old_row.workspace_id);
  select coalesce(
    (select label from public.own_account_identifiers where workspace_id = old_row.workspace_id and iban = p_iban limit 1),
    (select account_name from public.bank_connection_accounts where workspace_id = old_row.workspace_id and upper(replace(iban, ' ', '')) = p_iban limit 1)
  ) into own_label;
  if own_label is null then raise exception 'Own account not found' using errcode = 'P0002'; end if;
  if old_row.version is distinct from p_expected_version then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;
  if old_row.status <> 'posted' or old_row.kind <> 'ordinary' or old_row.transfer_id is not null or old_row.refund_of_id is not null
    or old_row.amount_minor = 0 or not (old_row.review_reasons <@ array['source_transfer']::text[])
    or exists (select 1 from public.transactions where refund_of_id = old_row.id or transfer_id = old_row.id)
    or exists (select 1 from public.transaction_split_sets where transaction_id = old_row.id and undone_at is null)
    or exists (select 1 from public.transaction_links where undone_at is null and (primary_transaction_id = old_row.id or counterpart_transaction_id = old_row.id))
  then raise exception 'Only posted, unlinked, unsplit transactions can be marked' using errcode = '22023'; end if;

  update public.transactions set kind = 'transfer', review_reasons = '{}', version = version + 1
  where id = old_row.id returning * into new_row;
  insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
  values (old_row.workspace_id, old_row.id, actor,
    jsonb_build_object('category_id', old_row.category_id, 'note', old_row.note, 'kind', old_row.kind,
      'transfer_id', old_row.transfer_id, 'refund_of_id', old_row.refund_of_id,
      'review_reasons', to_jsonb(old_row.review_reasons), 'version', old_row.version),
    jsonb_build_object('category_id', new_row.category_id, 'note', new_row.note, 'kind', new_row.kind,
      'transfer_id', new_row.transfer_id, 'refund_of_id', new_row.refund_of_id,
      'review_reasons', to_jsonb(new_row.review_reasons), 'version', new_row.version,
      'operation', 'own_account_transfer', 'identifier_id', null, 'own_account', own_label));
  return new_row;
end;
$$;

revoke all on function public.mark_own_iban_transfer(uuid, integer, text) from public, anon;
grant execute on function public.mark_own_iban_transfer(uuid, integer, text) to authenticated, service_role;
