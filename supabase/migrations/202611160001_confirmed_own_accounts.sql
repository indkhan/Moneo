alter table public.own_account_identifiers
  alter column iban drop not null,
  add column name_key text check (name_key is null or char_length(name_key) between 1 and 120),
  add column confirmed boolean not null default false,
  add constraint own_account_identifiers_identity_check check ((iban is not null) <> (name_key is not null)),
  add constraint own_account_identifiers_workspace_id_name_key_key unique (workspace_id, name_key);

create function public.undo_own_account_confirmation(p_identifier_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  identifier public.own_account_identifiers%rowtype;
  event_row public.correction_events%rowtype;
  reverted integer := 0;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into identifier from public.own_account_identifiers
  where id = p_identifier_id and confirmed and account_id is null and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Confirmed own account not found' using errcode = 'P0002'; end if;
  for event_row in
    select * from public.correction_events
    where workspace_id = identifier.workspace_id and not undone and after->>'operation' = 'own_account_transfer' and after->>'identifier_id' = p_identifier_id::text
    order by created_at desc for update
  loop
    update public.transactions
    set kind = event_row.before->>'kind',
        review_reasons = array(select jsonb_array_elements_text(event_row.before->'review_reasons')),
        version = version + 1
    where id = event_row.transaction_id and workspace_id = identifier.workspace_id
      and version = (event_row.after->>'version')::integer and kind = 'transfer' and transfer_id is null;
    if found then
      update public.correction_events set undone = true where id = event_row.id;
      reverted := reverted + 1;
    end if;
  end loop;
  delete from public.own_account_identifiers where id = identifier.id;
  return reverted;
end;
$$;

revoke all on function public.undo_own_account_confirmation(uuid) from public, anon;
grant execute on function public.undo_own_account_confirmation(uuid) to authenticated;
