-- Original timestamp strings stay in immutable source rows. UTC instants require reviewed timezone evidence.
alter table public.transactions add column posted_at timestamptz;
alter table public.source_transactions add column fee_evidence jsonb;
alter table public.source_transactions add constraint source_transactions_fee_evidence_check check
  (fee_evidence is null or (jsonb_typeof(fee_evidence) = 'object' and fee_evidence->>'treatment' is not null and fee_evidence->>'treatment' in ('included','additional','unknown')));
alter table public.balance_snapshots add column boundary_kind text not null default 'date_only';
alter table public.balance_snapshots add column source_transaction_id uuid references public.source_transactions(id);
alter table public.balance_snapshots add constraint balance_snapshots_boundary_kind_check check
  (boundary_kind in ('date_only','after_transaction') and (boundary_kind <> 'after_transaction' or source_transaction_id is not null));
create index transactions_account_posted_at_idx on public.transactions(workspace_id,account_id,posted_at) where posted_at is not null;

create function public.guard_balance_snapshot_scope() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.accounts a where a.id = new.account_id and a.workspace_id = new.workspace_id and a.currency_code = new.currency_code) then
    raise exception 'Balance account or currency is outside the workspace' using errcode = '23503';
  end if;
  if new.source_transaction_id is not null and not exists (
    select 1 from public.source_transactions s join public.transaction_sources l on l.source_transaction_id = s.id
      join public.transactions t on t.id = l.transaction_id
    where s.id = new.source_transaction_id and s.workspace_id = new.workspace_id and t.workspace_id = new.workspace_id
      and t.account_id = new.account_id and t.currency_code = new.currency_code
  ) then raise exception 'Balance source is outside the account or workspace' using errcode = '23503'; end if;
  return new;
end;
$$;
revoke all on function public.guard_balance_snapshot_scope() from public;
create trigger balance_snapshot_scope_guard before insert or update on public.balance_snapshots
  for each row execute function public.guard_balance_snapshot_scope();

-- Never reinterpret old offsetless mappings. Their date-only snapshots remain visibly uncertain.
