-- Own accounts: the IBANs that belong to the workspace owner, so money moved between
-- them is recognised as a transfer instead of income or spending.
--
-- An identifier either belongs to a tracked Moneo account (account_id set) or names an
-- account of the owner that Moneo does not track (account_id null, e.g. savings at a
-- bank that is not imported). Bank-connected accounts already carry their IBAN in
-- bank_connection_accounts; this table covers everything else.
create table public.own_account_identifiers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete cascade,
  iban text not null check (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$'),
  label text not null check (char_length(btrim(label)) between 1 and 120),
  created_at timestamptz not null default now(),
  unique (workspace_id, iban)
);

alter table public.own_account_identifiers enable row level security;
create policy own_account_identifiers_owned on public.own_account_identifiers for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id)
  and (account_id is null or exists (select 1 from public.accounts where id = account_id and workspace_id = own_account_identifiers.workspace_id)));
grant select, insert, delete on public.own_account_identifiers to authenticated;

-- One leg of a transfer whose other side is an own account Moneo does not track.
-- kind='transfer' with no transfer_id; the source review flag 'source_transfer' is
-- resolved by this decision. Audited as a correction event and undone with
-- undo_own_account_transfer, which restores kind and review flags exactly.
create function public.mark_own_account_transfer(
  p_transaction_id uuid,
  p_expected_version integer,
  p_identifier_id uuid
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  old_row public.transactions%rowtype;
  new_row public.transactions%rowtype;
  identifier public.own_account_identifiers%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into old_row from public.transactions
  where id = p_transaction_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Transaction not found' using errcode = 'P0002'; end if;
  select * into identifier from public.own_account_identifiers
  where id = p_identifier_id and workspace_id = old_row.workspace_id and account_id is null;
  if not found then raise exception 'Own untracked account not found' using errcode = 'P0002'; end if;
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
      'operation', 'own_account_transfer', 'identifier_id', identifier.id, 'own_account', identifier.label));
  return new_row;
end;
$$;

create function public.undo_own_account_transfer(
  p_event_id uuid,
  p_expected_version integer
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  event_row public.correction_events%rowtype;
  old_row public.transactions%rowtype;
  new_row public.transactions%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into event_row from public.correction_events
  where id = p_event_id and public.owns_workspace(workspace_id) and after->>'operation' = 'own_account_transfer';
  if not found then raise exception 'Correction not found' using errcode = 'P0002'; end if;
  select * into old_row from public.transactions
  where id = event_row.transaction_id and workspace_id = event_row.workspace_id for update;
  if old_row.version is distinct from p_expected_version or event_row.undone
    or old_row.version is distinct from (event_row.after->>'version')::integer
    or old_row.kind <> 'transfer' or old_row.transfer_id is not null then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;
  update public.transactions
  set kind = event_row.before->>'kind',
      review_reasons = array(select jsonb_array_elements_text(event_row.before->'review_reasons')),
      version = version + 1
  where id = old_row.id returning * into new_row;
  update public.correction_events set undone = true where id = p_event_id;
  return new_row;
end;
$$;

revoke all on function public.mark_own_account_transfer(uuid, integer, uuid) from public, anon;
revoke all on function public.undo_own_account_transfer(uuid, integer) from public, anon;
grant execute on function public.mark_own_account_transfer(uuid, integer, uuid) to authenticated;
grant execute on function public.undo_own_account_transfer(uuid, integer) to authenticated;
