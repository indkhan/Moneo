-- A loan repayment as a durable, audited link: which bank payment, in the financial state it had when accepted, against
-- which loan, for how much. So one receipt can't settle more than its amount, a cancelled payment can't be used, and a
-- later bank correction asks the owner again. Undoing the Wealth change undoes the link. Reset clears it with the workspace.
create table public.iou_repayments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  item_id uuid not null references public.wealth_items(id) on delete cascade,
  transaction_id uuid references public.transactions(id) on delete set null,
  wealth_event_id uuid not null references public.wealth_events(id) on delete cascade,
  applied_minor bigint not null check (applied_minor > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  transaction_amount_minor bigint not null,
  transaction_posted_on date not null,
  request_id uuid not null,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  unique (workspace_id, request_id)
);
create index iou_repayments_transaction on public.iou_repayments(transaction_id) where undone_at is null;
create index iou_repayments_item on public.iou_repayments(item_id);
alter table public.iou_repayments enable row level security;
create policy iou_repayments_owner_select on public.iou_repayments for select to authenticated using (public.owns_workspace(workspace_id));
revoke all on public.iou_repayments from public, anon, authenticated;
grant select on public.iou_repayments to authenticated;
grant all on public.iou_repayments to service_role;

create function public.apply_iou_repayment(p_item_id uuid, p_transaction_id uuid, p_applied_minor bigint, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item public.wealth_items%rowtype; previous public.wealth_items%rowtype; row public.transactions%rowtype; prior public.iou_repayments%rowtype; paid bigint; lent boolean; left_after bigint; used bigint; zone text; event_id uuid:=gen_random_uuid(); repayment uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_item_id is null or p_transaction_id is null or p_applied_minor is null or p_applied_minor<=0 or p_request_id is null then raise exception 'Invalid repayment' using errcode='22023'; end if;
  -- Same order as corrections: the transaction first, so two cards for one receipt wait for each other.
  select * into row from public.transactions where id=p_transaction_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'The transaction no longer matches this repayment' using errcode='P0002'; end if;
  select * into prior from public.iou_repayments where workspace_id=row.workspace_id and request_id=p_request_id;
  if found then return jsonb_build_object('id',prior.id,'itemId',prior.item_id); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wealth:'||p_item_id::text,0));
  select * into item from public.wealth_items where id=p_item_id and workspace_id=row.workspace_id for update;
  if not found or item.removed_at is not null or item.linked_account_id is not null or not (item.name like 'Lent to %' or item.name like 'Owed to %') then raise exception 'This loan changed or was removed since the repayment was found' using errcode='P0002'; end if;
  lent:=item.kind='asset';
  if row.status<>'posted' or row.currency_code<>item.currency_code or (lent and row.amount_minor<=0) or (not lent and row.amount_minor>=0) then raise exception 'The transaction no longer matches this repayment' using errcode='22023'; end if;
  paid:=abs(row.amount_minor);
  select coalesce(sum(applied_minor),0) into used from public.iou_repayments where transaction_id=row.id and undone_at is null;
  if used+p_applied_minor>paid then raise exception 'This payment has already been counted against a loan' using errcode='22023'; end if;
  if p_applied_minor>abs(item.amount_minor) then raise exception 'This is more than is still owed on the loan' using errcode='22023'; end if;
  -- The value changes on the bank's date, and a value can't step back in time, so older payments go first.
  if row.posted_on<item.as_of then raise exception 'This loan''s value is dated after this payment. Accept its repayments oldest first, or update the loan.' using errcode='22023'; end if;
  previous:=item;
  left_after:=abs(item.amount_minor)-p_applied_minor;
  item.version:=item.version+1; item.updated_at:=now();
  if left_after=0 then
    select timezone into zone from public.workspace_settings where workspace_id=row.workspace_id;
    item.removed_at:=(row.posted_on::timestamp) at time zone coalesce(zone,'Europe/Berlin');
  else
    item.amount_minor:=case when lent then left_after else -left_after end;
    item.as_of:=row.posted_on;
  end if;
  update public.wealth_items set amount_minor=item.amount_minor,as_of=item.as_of,removed_at=item.removed_at,version=item.version,updated_at=item.updated_at where id=item.id;
  insert into public.wealth_events(id,workspace_id,item_id,actor_id,request_id,before,after)
    values(event_id,item.workspace_id,item.id,auth.uid(),p_request_id,public.wealth_record(previous),public.wealth_record(item));
  insert into public.iou_repayments(workspace_id,item_id,transaction_id,wealth_event_id,applied_minor,currency_code,transaction_amount_minor,transaction_posted_on,request_id,actor_id)
    values(item.workspace_id,item.id,row.id,event_id,p_applied_minor,row.currency_code,row.amount_minor,row.posted_on,p_request_id,auth.uid()) returning id into repayment;
  return jsonb_build_object('id',repayment,'itemId',item.id);
end;
$$;
revoke all on function public.apply_iou_repayment(uuid, uuid, bigint, uuid) from public, anon;
grant execute on function public.apply_iou_repayment(uuid, uuid, bigint, uuid) to authenticated;

-- The bank corrected the payment and the owner says the repayment still stands: remember the state they just confirmed.
create function public.confirm_iou_repayment(p_repayment_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare link public.iou_repayments%rowtype; row public.transactions%rowtype; used bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into link from public.iou_repayments where id=p_repayment_id and public.owns_workspace(workspace_id) and undone_at is null for update;
  if not found then raise exception 'This repayment was removed' using errcode='P0002'; end if;
  select * into row from public.transactions where id=link.transaction_id for update;
  if not found or row.status<>'posted' or row.currency_code<>link.currency_code then raise exception 'The payment is gone, so undo this repayment in the Wealth history' using errcode='22023'; end if;
  select coalesce(sum(applied_minor),0) into used from public.iou_repayments where transaction_id=row.id and undone_at is null;
  if used>abs(row.amount_minor) or sign(row.amount_minor)<>sign(link.transaction_amount_minor) then raise exception 'The payment no longer covers this repayment, so undo it in the Wealth history' using errcode='22023'; end if;
  update public.iou_repayments set transaction_amount_minor=row.amount_minor,transaction_posted_on=row.posted_on where id=link.id;
end;
$$;
revoke all on function public.confirm_iou_repayment(uuid) from public, anon;
grant execute on function public.confirm_iou_repayment(uuid) to authenticated;

-- Undoing the Wealth change undoes the link, so the receipt can be used again.
create function public.undo_iou_repayment_with_wealth_event() returns trigger language plpgsql security definer set search_path='' as $$
begin
  update public.iou_repayments set undone_at=new.undone_at where wealth_event_id=new.id and undone_at is null;
  return new;
end;
$$;
revoke all on function public.undo_iou_repayment_with_wealth_event() from public, anon, authenticated;
create trigger wealth_event_undone_repayment after update of undone_at on public.wealth_events
  for each row when (new.undone_at is not null and old.undone_at is null) execute function public.undo_iou_repayment_with_wealth_event();

-- "Add this cash withdrawal to your Cash account?" cards, raised after a bank row is recognised as a cash machine withdrawal.
alter table public.agent_proposals drop constraint agent_proposals_kind_check;
alter table public.agent_proposals add constraint agent_proposals_kind_check check (kind in ('categorize','recurring','budget','finding','iou_create','iou_settle','transaction_create','balance_set','recurring_edit','scalable_order','scalable_cancel','own_transfer','cash_withdrawal'));
drop policy own_agent_proposals_standalone_insert on public.agent_proposals;
create policy own_agent_proposals_standalone_insert on public.agent_proposals for insert to authenticated
  with check (public.owns_workspace(workspace_id) and run_id is null and kind in ('iou_create','iou_settle','transaction_create','balance_set','recurring_edit','scalable_order','scalable_cancel','own_transfer','cash_withdrawal') and status = 'proposed');
