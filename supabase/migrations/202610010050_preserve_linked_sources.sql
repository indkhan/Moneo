-- Legacy self-links used ON DELETE SET NULL. Refuse deletion before those cascades can erase attribution.
-- Untouched unsourced manual creation undo still writes its retained tombstone through024.
create function public.guard_financial_source_delete() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.transfer_id is not null or old.refund_of_id is not null
    or exists(select 1 from public.transactions where transfer_id=old.id or refund_of_id=old.id)
    or exists(select 1 from public.transaction_sources where transaction_id=old.id)
    or exists(select 1 from public.correction_events where transaction_id=old.id)
    or exists(select 1 from public.recurring_series_transactions where transaction_id=old.id)
    or exists(select 1 from public.transaction_split_sets where transaction_id=old.id)
    or exists(select 1 from public.transaction_links where primary_transaction_id=old.id or counterpart_transaction_id=old.id)
    then raise exception 'Linked, corrected or source-backed financial evidence must be retained; undo the relevant change instead' using errcode='22023'; end if;
  return old;
end;
$$;
revoke all on function public.guard_financial_source_delete() from public,anon,authenticated;
create trigger transactions_preserve_source_delete before delete on public.transactions for each row execute function public.guard_financial_source_delete();
