-- Own money that arrives or leaves without an IBAN: a cash machine, Scalable Capital (its broker
-- withdrawals carry no IBAN), or an old account of the owner known only by their name on it.
-- Same audit as mark_own_account_transfer (operation own_account_transfer, no identifier), so
-- undo_own_account_transfer restores the row exactly.
--   cash      the bank's wording says cash machine; background jobs may mark it.
--   scalable  the owner connected Scalable; background jobs may mark it.
--   owner     only the signed-in owner, by accepting an own_transfer card (a name is weak evidence).
create function public.mark_own_named_transfer(
  p_transaction_id uuid,
  p_expected_version integer,
  p_kind text,
  p_label text default null
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  old_row public.transactions%rowtype;
  new_row public.transactions%rowtype;
  own_label text;
begin
  if auth.uid() is null and (select auth.jwt()->>'role') is distinct from 'service_role' then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_kind is null or p_kind not in ('cash', 'scalable', 'owner') then raise exception 'Unknown own account' using errcode = '22023'; end if;
  if p_kind = 'owner' and auth.uid() is null then raise exception 'Only the owner can confirm this' using errcode = '42501'; end if;
  select * into old_row from public.transactions
  where id = p_transaction_id and public.can_link_workspace(workspace_id) for update;
  if not found then raise exception 'Transaction not found' using errcode = 'P0002'; end if;
  actor := public.link_actor(old_row.workspace_id);
  if p_kind = 'scalable' and not exists (select 1 from public.scalable_connections where workspace_id = old_row.workspace_id and status = 'active') then
    raise exception 'Scalable Capital is not connected' using errcode = '22023';
  end if;
  own_label := case p_kind when 'cash' then 'Cash' when 'scalable' then 'Scalable Capital' else btrim(coalesce(p_label, '')) end;
  if char_length(own_label) not between 1 and 120 then raise exception 'Name the own account' using errcode = '22023'; end if;
  if old_row.version is distinct from p_expected_version then
    raise exception 'Transaction changed; refresh and retry' using errcode = 'PT409';
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
      'operation', 'own_account_transfer', 'identifier_id', null, 'own_account', own_label, 'rule', p_kind));
  return new_row;
end;
$$;

revoke all on function public.mark_own_named_transfer(uuid, integer, text, text) from public, anon;
grant execute on function public.mark_own_named_transfer(uuid, integer, text, text) to authenticated, service_role;

-- "Is this your own money?" cards, raised when a payment names the owner as seen on their own IBANs.
alter table public.agent_proposals drop constraint agent_proposals_kind_check;
alter table public.agent_proposals add constraint agent_proposals_kind_check check (kind in ('categorize','recurring','budget','finding','iou_create','iou_settle','transaction_create','balance_set','recurring_edit','scalable_order','scalable_cancel','own_transfer'));
drop policy own_agent_proposals_standalone_insert on public.agent_proposals;
create policy own_agent_proposals_standalone_insert on public.agent_proposals for insert to authenticated
  with check (public.owns_workspace(workspace_id) and run_id is null and kind in ('iou_create','iou_settle','transaction_create','balance_set','recurring_edit','scalable_order','scalable_cancel','own_transfer') and status = 'proposed');
