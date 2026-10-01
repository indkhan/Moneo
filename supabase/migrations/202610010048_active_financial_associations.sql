-- Existing archived obligations remain editable/removable; new associations require an active account.
create function public.guard_active_financial_account() returns trigger language plpgsql security definer set search_path='' as $$
declare account_id uuid; previous_id uuid; account public.accounts%rowtype;
begin
  if tg_table_name='wealth_items' then
    account_id:=new.payment_account_id;
    if tg_op='UPDATE' then previous_id:=old.payment_account_id; end if;
  else
    account_id:=new.account_id;
    if tg_op='UPDATE' then previous_id:=old.account_id; end if;
  end if;
  if account_id is null or (tg_op='UPDATE' and account_id is not distinct from previous_id) then return new; end if;
  select * into account from public.accounts where id=account_id for share;
  if not found or account.workspace_id<>new.workspace_id or account.currency_code<>new.currency_code or account.archived_at is not null
    or (tg_table_name='wealth_items' and account.type not in ('checking','savings','cash','wallet')) then
    raise exception 'A new financial association requires an active owned account in the same currency' using errcode='22023'; end if;
  return new;
end;
$$;
revoke all on function public.guard_active_financial_account() from public,anon,authenticated;
create trigger assumption_active_account before insert or update of account_id on public.financial_assumptions for each row execute function public.guard_active_financial_account();
create trigger scenario_active_account before insert or update of account_id on public.scenario_overrides for each row execute function public.guard_active_financial_account();
create trigger wealth_payment_active_account before insert or update of payment_account_id on public.wealth_items for each row execute function public.guard_active_financial_account();
