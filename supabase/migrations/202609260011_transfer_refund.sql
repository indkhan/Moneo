-- Explicit user marking of an accepted (posted) transaction as transfer or refund.
--
-- Scope: minimal and safe. All writes go through SECURITY DEFINER RPCs because
-- direct UPDATE/DELETE on public.transactions stays revoked (see
-- 202609260002_transaction_corrections.sql). Every decision inserts
-- correction_events rows and bumps version, so the existing
-- undo_transaction_correction flow (extended below for kind/link keys) can
-- undo it. Category corrections via correct_transaction preserve kind/links.
--
-- Invariants enforced in the RPCs (cross-row checks cannot be CHECKs):
-- * Transfer pair: same workspace, different accounts, same currency,
--   opposite signed matching amounts (a.amount = -b.amount, nonzero).
-- * Refund: same workspace/account/currency, opposite signs (partial refunds
--   allowed, so exact magnitude match is NOT required). Standalone refunds
--   (no original) are allowed when the original cannot be found.
-- * Only posted transactions can be marked; clearing accepts any status as a
--   repair path. Amounts/accounts/status are otherwise immutable (no RPC
--   changes them), so pair compatibility cannot drift except via kind/links.
-- Assumptions documented: refund originals must be ordinary (no
-- refund-of-refund, no refund-of-transfer); transfer sides must have no
-- refund links and no inbound refunds; transfer links are symmetric
-- (both sides kind='transfer' pointing at each other).

-- Defense in depth for the link columns (pair rules stay in the RPCs).
alter table public.transactions
  add constraint transactions_kind_check
  check (kind in ('ordinary', 'transfer', 'refund'));
alter table public.transactions
  add constraint transactions_no_self_transfer
  check (transfer_id is null or transfer_id <> id);
alter table public.transactions
  add constraint transactions_no_self_refund
  check (refund_of_id is null or refund_of_id <> id);
alter table public.transactions
  add constraint transactions_transfer_id_fkey
  foreign key (transfer_id) references public.transactions(id) on delete set null;
alter table public.transactions
  add constraint transactions_refund_of_id_fkey
  foreign key (refund_of_id) references public.transactions(id) on delete set null;

create index if not exists transactions_transfer_id_idx
  on public.transactions (transfer_id) where transfer_id is not null;
create index if not exists transactions_refund_of_id_idx
  on public.transactions (refund_of_id) where refund_of_id is not null;

-- Keep the existing workspace linkage guarantees and extend them to transfer_id.
drop policy if exists own_transactions on public.transactions;
create policy own_transactions on public.transactions for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id)
  and exists (select 1 from public.accounts where id = account_id and workspace_id = transactions.workspace_id)
  and (category_id is null or exists (select 1 from public.categories where id = category_id and workspace_id = transactions.workspace_id))
  and (refund_of_id is null or exists (select 1 from public.transactions where id = refund_of_id and workspace_id = transactions.workspace_id))
  and (transfer_id is null or exists (select 1 from public.transactions where id = transfer_id and workspace_id = transactions.workspace_id))
);

-- Mark a posted transaction as one side of a transfer pair. Both sides become
-- kind='transfer' with symmetric transfer_id pointers. Idempotent when the
-- pair is already linked; otherwise bumps both versions and audits both rows.
create or replace function public.mark_transaction_transfer(
  p_transaction_id uuid,
  p_expected_version integer,
  p_counterpart_id uuid
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  primary_row public.transactions%rowtype;
  counterpart_row public.transactions%rowtype;
  new_primary public.transactions%rowtype;
  new_counterpart public.transactions%rowtype;
  inbound_refunds integer;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_transaction_id is null or p_counterpart_id is null then
    raise exception 'Transfer pair is required' using errcode = '22023';
  end if;
  if p_transaction_id = p_counterpart_id then
    raise exception 'A transaction cannot transfer to itself' using errcode = '22023';
  end if;

  -- Lock in stable id order to avoid deadlocks on concurrent pair markings.
  if p_transaction_id < p_counterpart_id then
    select * into primary_row from public.transactions
    where id = p_transaction_id and public.owns_workspace(workspace_id) for update;
    select * into counterpart_row from public.transactions
    where id = p_counterpart_id and public.owns_workspace(workspace_id) for update;
  else
    select * into counterpart_row from public.transactions
    where id = p_counterpart_id and public.owns_workspace(workspace_id) for update;
    select * into primary_row from public.transactions
    where id = p_transaction_id and public.owns_workspace(workspace_id) for update;
  end if;
  if primary_row.id is null or counterpart_row.id is null then
    raise exception 'Transaction not found' using errcode = 'P0002';
  end if;
  if primary_row.workspace_id <> counterpart_row.workspace_id then
    raise exception 'Transfer pair must be in the same workspace' using errcode = '22023';
  end if;
  if primary_row.version is distinct from p_expected_version then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;
  if primary_row.status <> 'posted' or counterpart_row.status <> 'posted' then
    raise exception 'Only posted transactions can be marked as transfers' using errcode = '22023';
  end if;
  if primary_row.account_id = counterpart_row.account_id then
    raise exception 'Transfer requires two different accounts' using errcode = '22023';
  end if;
  if primary_row.currency_code <> counterpart_row.currency_code
     or primary_row.amount_minor = 0
     or primary_row.amount_minor <> -counterpart_row.amount_minor then
    raise exception 'Transfer pair must have opposite signed matching amounts in the same currency' using errcode = '22023';
  end if;
  if primary_row.refund_of_id is not null or counterpart_row.refund_of_id is not null then
    raise exception 'Refunded transactions cannot be marked as transfers' using errcode = '22023';
  end if;
  if (primary_row.transfer_id is not null and primary_row.transfer_id <> counterpart_row.id)
     or (counterpart_row.transfer_id is not null and counterpart_row.transfer_id <> primary_row.id) then
    raise exception 'Transaction is already linked as a transfer' using errcode = '22023';
  end if;
  if (primary_row.kind <> 'ordinary' or counterpart_row.kind <> 'ordinary')
     and not (primary_row.kind = 'transfer' and counterpart_row.kind = 'transfer'
       and primary_row.transfer_id = counterpart_row.id
       and counterpart_row.transfer_id = primary_row.id) then
    raise exception 'Only ordinary transactions can be newly paired as a transfer' using errcode = '22023';
  end if;
  select count(*) into inbound_refunds from public.transactions
  where refund_of_id in (primary_row.id, counterpart_row.id)
    and workspace_id = primary_row.workspace_id;
  if inbound_refunds > 0 then
    raise exception 'Transaction with linked refunds cannot be marked as a transfer' using errcode = '22023';
  end if;

  if primary_row.kind = 'transfer' and counterpart_row.kind = 'transfer'
     and primary_row.transfer_id = counterpart_row.id
     and counterpart_row.transfer_id = primary_row.id then
    return primary_row;
  end if;

  update public.transactions set kind = 'transfer', transfer_id = counterpart_row.id, version = version + 1
  where id = primary_row.id returning * into new_primary;
  update public.transactions set kind = 'transfer', transfer_id = primary_row.id, version = version + 1
  where id = counterpart_row.id returning * into new_counterpart;

  insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
  values (primary_row.workspace_id, primary_row.id, actor,
    jsonb_build_object('category_id', primary_row.category_id, 'note', primary_row.note,
      'kind', primary_row.kind, 'transfer_id', primary_row.transfer_id,
      'refund_of_id', primary_row.refund_of_id, 'version', primary_row.version),
    jsonb_build_object('category_id', new_primary.category_id, 'note', new_primary.note,
      'kind', new_primary.kind, 'transfer_id', new_primary.transfer_id,
      'refund_of_id', new_primary.refund_of_id, 'version', new_primary.version));
  insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
  values (counterpart_row.workspace_id, counterpart_row.id, actor,
    jsonb_build_object('category_id', counterpart_row.category_id, 'note', counterpart_row.note,
      'kind', counterpart_row.kind, 'transfer_id', counterpart_row.transfer_id,
      'refund_of_id', counterpart_row.refund_of_id, 'version', counterpart_row.version),
    jsonb_build_object('category_id', new_counterpart.category_id, 'note', new_counterpart.note,
      'kind', new_counterpart.kind, 'transfer_id', new_counterpart.transfer_id,
      'refund_of_id', new_counterpart.refund_of_id, 'version', new_counterpart.version));
  return new_primary;
end;
$$;

-- Mark a posted transaction as a refund. p_original_id may be null for a
-- standalone refund when the original cannot be found. Idempotent when the
-- same marking already applies. Only the refund row is modified and audited.
create or replace function public.mark_transaction_refund(
  p_transaction_id uuid,
  p_expected_version integer,
  p_original_id uuid
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  primary_row public.transactions%rowtype;
  original_row public.transactions%rowtype;
  new_row public.transactions%rowtype;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_original_id is not null and p_transaction_id = p_original_id then
    raise exception 'A transaction cannot refund itself' using errcode = '22023';
  end if;

  if p_original_id is null then
    select * into primary_row from public.transactions
    where id = p_transaction_id and public.owns_workspace(workspace_id) for update;
    if not found then
      raise exception 'Transaction not found' using errcode = 'P0002';
    end if;
    if primary_row.version is distinct from p_expected_version then
      raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
    end if;
    if primary_row.status <> 'posted' then
      raise exception 'Only posted transactions can be marked as refunds' using errcode = '22023';
    end if;
    if primary_row.amount_minor <= 0 then
      raise exception 'A spending refund must be a positive amount' using errcode = '22023';
    end if;
    if primary_row.transfer_id is not null then
      raise exception 'Clear the transfer link before marking as a refund' using errcode = '22023';
    end if;
    if primary_row.kind = 'refund' and primary_row.refund_of_id is null then
      return primary_row;
    end if;
    update public.transactions set kind = 'refund', refund_of_id = null, version = version + 1
    where id = primary_row.id returning * into new_row;
    insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
    values (primary_row.workspace_id, primary_row.id, actor,
      jsonb_build_object('category_id', primary_row.category_id, 'note', primary_row.note,
        'kind', primary_row.kind, 'transfer_id', primary_row.transfer_id,
        'refund_of_id', primary_row.refund_of_id, 'version', primary_row.version),
      jsonb_build_object('category_id', new_row.category_id, 'note', new_row.note,
        'kind', new_row.kind, 'transfer_id', new_row.transfer_id,
        'refund_of_id', new_row.refund_of_id, 'version', new_row.version));
    return new_row;
  end if;

  if p_transaction_id < p_original_id then
    select * into primary_row from public.transactions
    where id = p_transaction_id and public.owns_workspace(workspace_id) for update;
    select * into original_row from public.transactions
    where id = p_original_id and public.owns_workspace(workspace_id) for update;
  else
    select * into original_row from public.transactions
    where id = p_original_id and public.owns_workspace(workspace_id) for update;
    select * into primary_row from public.transactions
    where id = p_transaction_id and public.owns_workspace(workspace_id) for update;
  end if;
  if primary_row.id is null or original_row.id is null then
    raise exception 'Transaction not found' using errcode = 'P0002';
  end if;
  if primary_row.workspace_id <> original_row.workspace_id then
    raise exception 'Refund and original must be in the same workspace' using errcode = '22023';
  end if;
  if primary_row.version is distinct from p_expected_version then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;
  if primary_row.status <> 'posted' or original_row.status <> 'posted' then
    raise exception 'Only posted transactions can be linked as refunds' using errcode = '22023';
  end if;
  if primary_row.account_id <> original_row.account_id then
    raise exception 'Refund and original must be in the same account' using errcode = '22023';
  end if;
  if primary_row.currency_code <> original_row.currency_code then
    raise exception 'Refund and original must share the same currency' using errcode = '22023';
  end if;
  if primary_row.amount_minor <= 0 or original_row.amount_minor >= 0 then
    raise exception 'A refund must credit an earlier expense' using errcode = '22023';
  end if;
  if original_row.posted_on > primary_row.posted_on then
    raise exception 'Refund original must predate the refund' using errcode = '22023';
  end if;
  if original_row.kind <> 'ordinary' then
    raise exception 'Refunds can only link to ordinary transactions' using errcode = '22023';
  end if;
  if primary_row.transfer_id is not null then
    raise exception 'Clear the transfer link before marking as a refund' using errcode = '22023';
  end if;

  if primary_row.kind = 'refund' and primary_row.refund_of_id = original_row.id then
    return primary_row;
  end if;

  update public.transactions set kind = 'refund', refund_of_id = original_row.id, version = version + 1
  where id = primary_row.id returning * into new_row;
  insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
  values (primary_row.workspace_id, primary_row.id, actor,
    jsonb_build_object('category_id', primary_row.category_id, 'note', primary_row.note,
      'kind', primary_row.kind, 'transfer_id', primary_row.transfer_id,
      'refund_of_id', primary_row.refund_of_id, 'version', primary_row.version),
    jsonb_build_object('category_id', new_row.category_id, 'note', new_row.note,
      'kind', new_row.kind, 'transfer_id', new_row.transfer_id,
      'refund_of_id', new_row.refund_of_id, 'version', new_row.version));
  return new_row;
end;
$$;

-- Clear a transfer/refund marking back to ordinary. For transfers both sides
-- are cleared atomically when the counterpart still points back. Idempotent.
create or replace function public.clear_transaction_link(
  p_transaction_id uuid,
  p_expected_version integer
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  primary_row public.transactions%rowtype;
  counterpart_row public.transactions%rowtype;
  new_primary public.transactions%rowtype;
  new_counterpart public.transactions%rowtype;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into primary_row from public.transactions
  where id = p_transaction_id and public.owns_workspace(workspace_id) for update;
  if not found then
    raise exception 'Transaction not found' using errcode = 'P0002';
  end if;
  if primary_row.version is distinct from p_expected_version then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;
  if primary_row.kind = 'ordinary' and primary_row.transfer_id is null and primary_row.refund_of_id is null then
    return primary_row;
  end if;

  if primary_row.kind = 'transfer' and primary_row.transfer_id is not null then
    select * into counterpart_row from public.transactions
    where id = primary_row.transfer_id and workspace_id = primary_row.workspace_id for update;
    update public.transactions set kind = 'ordinary', transfer_id = null, version = version + 1
    where id = primary_row.id returning * into new_primary;
    insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
    values (primary_row.workspace_id, primary_row.id, actor,
      jsonb_build_object('category_id', primary_row.category_id, 'note', primary_row.note,
        'kind', primary_row.kind, 'transfer_id', primary_row.transfer_id,
        'refund_of_id', primary_row.refund_of_id, 'version', primary_row.version),
      jsonb_build_object('category_id', new_primary.category_id, 'note', new_primary.note,
        'kind', new_primary.kind, 'transfer_id', new_primary.transfer_id,
        'refund_of_id', new_primary.refund_of_id, 'version', new_primary.version));
    if counterpart_row.id is not null and counterpart_row.transfer_id = primary_row.id then
      update public.transactions set kind = 'ordinary', transfer_id = null, version = version + 1
      where id = counterpart_row.id returning * into new_counterpart;
      insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
      values (counterpart_row.workspace_id, counterpart_row.id, actor,
        jsonb_build_object('category_id', counterpart_row.category_id, 'note', counterpart_row.note,
          'kind', counterpart_row.kind, 'transfer_id', counterpart_row.transfer_id,
          'refund_of_id', counterpart_row.refund_of_id, 'version', counterpart_row.version),
        jsonb_build_object('category_id', new_counterpart.category_id, 'note', new_counterpart.note,
          'kind', new_counterpart.kind, 'transfer_id', new_counterpart.transfer_id,
          'refund_of_id', new_counterpart.refund_of_id, 'version', new_counterpart.version));
    end if;
    return new_primary;
  end if;

  update public.transactions set kind = 'ordinary', transfer_id = null, refund_of_id = null, version = version + 1
  where id = primary_row.id returning * into new_primary;
  insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
  values (primary_row.workspace_id, primary_row.id, actor,
    jsonb_build_object('category_id', primary_row.category_id, 'note', primary_row.note,
      'kind', primary_row.kind, 'transfer_id', primary_row.transfer_id,
      'refund_of_id', primary_row.refund_of_id, 'version', primary_row.version),
    jsonb_build_object('category_id', new_primary.category_id, 'note', new_primary.note,
      'kind', new_primary.kind, 'transfer_id', new_primary.transfer_id,
      'refund_of_id', new_primary.refund_of_id, 'version', new_primary.version));
  return new_primary;
end;
$$;

-- Extend undo to restore kind/transfer_id/refund_of_id for decisions audited
-- above, while staying backward compatible with older events that only carry
-- category_id/note/version (missing keys preserve the current value).
-- Transfer symmetry is repaired: clearing a stale back-pointer, or restoring
-- one when the counterpart is still compatible; otherwise undo is rejected
-- instead of leaving a dangling one-sided link.
create or replace function public.undo_transaction_correction(
  p_event_id uuid,
  p_expected_version integer
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  event_row public.correction_events%rowtype;
  old_row public.transactions%rowtype;
  new_row public.transactions%rowtype;
  actor uuid := auth.uid();
  transfer_related boolean;
  removed_link uuid;
  restored_link uuid;
  counterpart public.transactions%rowtype;
  repaired public.transactions%rowtype;
  inbound_refunds integer;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into event_row from public.correction_events
  where id = p_event_id and public.owns_workspace(workspace_id);
  if not found then
    raise exception 'Correction not found' using errcode = 'P0002';
  end if;

  select * into old_row from public.transactions
  where id = event_row.transaction_id and workspace_id = event_row.workspace_id
  for update;
  if old_row.version is distinct from p_expected_version then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;

  select * into event_row from public.correction_events
  where id = p_event_id and not undone and not exists (
    select 1 from public.correction_events newer
    where newer.transaction_id = correction_events.transaction_id
      and not newer.undone
      and (newer.after->>'version')::integer > (correction_events.after->>'version')::integer
  );
  if not found then
    raise exception 'Only the latest correction can be undone' using errcode = '40001';
  end if;
  if old_row.category_id is distinct from (event_row.after->>'category_id')::uuid
     or old_row.note is distinct from event_row.after->>'note' then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;
  if (event_row.after ? 'kind') and old_row.kind is distinct from (event_row.after->>'kind') then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;
  if (event_row.after ? 'transfer_id')
     and old_row.transfer_id is distinct from (event_row.after->>'transfer_id')::uuid then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;
  if (event_row.after ? 'refund_of_id')
     and old_row.refund_of_id is distinct from (event_row.after->>'refund_of_id')::uuid then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;

  update public.transactions
  set category_id = (event_row.before->>'category_id')::uuid,
      note = event_row.before->>'note',
      kind = case when event_row.before ? 'kind' then (event_row.before->>'kind') else kind end,
      transfer_id = case when event_row.before ? 'transfer_id'
        then (event_row.before->>'transfer_id')::uuid else transfer_id end,
      refund_of_id = case when event_row.before ? 'refund_of_id'
        then (event_row.before->>'refund_of_id')::uuid else refund_of_id end,
      version = version + 1
  where id = old_row.id
  returning * into new_row;
  update public.correction_events set undone = true where id = p_event_id;

  transfer_related := (event_row.before ? 'transfer_id') or (event_row.after ? 'transfer_id')
    or (event_row.before->>'kind' = 'transfer') or (event_row.after->>'kind' = 'transfer');
  if not transfer_related then
    return new_row;
  end if;

  removed_link := case when event_row.after ? 'transfer_id'
    then (event_row.after->>'transfer_id')::uuid else null end;
  restored_link := new_row.transfer_id;

  -- Undoing a mark/clear removed a link: clear the stale back-pointer.
  if removed_link is not null and removed_link is distinct from restored_link then
    select * into counterpart from public.transactions
    where id = removed_link and workspace_id = new_row.workspace_id for update;
    if counterpart.id is not null and counterpart.transfer_id = new_row.id then
      update public.transactions set kind = 'ordinary', transfer_id = null, version = version + 1
      where id = counterpart.id returning * into repaired;
      insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
      values (counterpart.workspace_id, counterpart.id, actor,
        jsonb_build_object('category_id', counterpart.category_id, 'note', counterpart.note,
          'kind', counterpart.kind, 'transfer_id', counterpart.transfer_id,
          'refund_of_id', counterpart.refund_of_id, 'version', counterpart.version),
        jsonb_build_object('category_id', repaired.category_id, 'note', repaired.note,
          'kind', repaired.kind, 'transfer_id', repaired.transfer_id,
          'refund_of_id', repaired.refund_of_id, 'version', repaired.version));
    end if;
  end if;

  -- Undoing a clear restored a link: restore the back-pointer when possible.
  if restored_link is not null then
    select * into counterpart from public.transactions
    where id = restored_link and workspace_id = new_row.workspace_id for update;
    if counterpart.id is null then
      raise exception 'Transfer counterpart is gone; clear and re-link manually' using errcode = 'P0002';
    end if;
    if counterpart.transfer_id is distinct from new_row.id then
      if counterpart.transfer_id is not null
         or counterpart.kind <> 'ordinary'
         or counterpart.refund_of_id is not null
         or new_row.refund_of_id is not null
         or counterpart.workspace_id <> new_row.workspace_id
         or counterpart.account_id = new_row.account_id
         or counterpart.currency_code <> new_row.currency_code
         or counterpart.amount_minor <> -new_row.amount_minor then
        -- Roll the primary restore back instead of leaving a one-sided link.
        raise exception 'Counterpart changed; clear and re-link manually' using errcode = '40001';
      end if;
      select count(*) into inbound_refunds from public.transactions
      where refund_of_id in (new_row.id, counterpart.id)
        and workspace_id = new_row.workspace_id;
      if inbound_refunds > 0 then
        raise exception 'Counterpart changed; clear and re-link manually' using errcode = '40001';
      end if;
      update public.transactions set kind = 'transfer', transfer_id = new_row.id, version = version + 1
      where id = counterpart.id returning * into repaired;
      insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
      values (counterpart.workspace_id, counterpart.id, actor,
        jsonb_build_object('category_id', counterpart.category_id, 'note', counterpart.note,
          'kind', counterpart.kind, 'transfer_id', counterpart.transfer_id,
          'refund_of_id', counterpart.refund_of_id, 'version', counterpart.version),
        jsonb_build_object('category_id', repaired.category_id, 'note', repaired.note,
          'kind', repaired.kind, 'transfer_id', repaired.transfer_id,
          'refund_of_id', repaired.refund_of_id, 'version', repaired.version));
    end if;
  end if;

  return new_row;
end;
$$;

revoke all on function public.mark_transaction_transfer(uuid, integer, uuid) from public;
revoke all on function public.mark_transaction_refund(uuid, integer, uuid) from public;
revoke all on function public.clear_transaction_link(uuid, integer) from public;
revoke all on function public.undo_transaction_correction(uuid, integer) from public;
grant execute on function public.mark_transaction_transfer(uuid, integer, uuid) to authenticated;
grant execute on function public.mark_transaction_refund(uuid, integer, uuid) to authenticated;
grant execute on function public.clear_transaction_link(uuid, integer) to authenticated;
grant execute on function public.undo_transaction_correction(uuid, integer) to authenticated;
