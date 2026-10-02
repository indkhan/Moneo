do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); item uuid:=gen_random_uuid(); request uuid:=gen_random_uuid(); record jsonb; result jsonb; event uuid; debt jsonb; other_account uuid:=gen_random_uuid(); pending uuid; assumption uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Wealth cash','EUR');
  record:=jsonb_build_object('kind','holding','name','Exact holding','currency_code','EUR','quantity_text','90071992547409.93','unit_price_text','1','amount_minor','9007199254740993','cost_basis_minor','9007199254740000','as_of','2026-10-02','linked_account_id',null,'payment_account_id',null,'annual_rate_text',null,'monthly_payment_minor',null,'next_payment_on',null,'payment_assumption_id',null,'payment_transaction_id',null);
  result:=public.edit_wealth_item(item,0,record,false,request); event:=(result->>'eventId')::uuid;
  if public.edit_wealth_item(item,0,record,false,request)<>result then raise exception 'Wealth retry duplicated evidence'; end if;
  if (select after->>'amount_minor' from public.wealth_events where id=event)<>'9007199254740993' then raise exception 'Wealth audit lost money precision'; end if;
  begin
    perform public.edit_wealth_item(item,0,record||'{"name":"Changed"}',false,gen_random_uuid());
    raise exception 'Stale wealth edit accepted';
  exception when sqlstate '40001' then null; end;
  begin
    perform public.edit_wealth_item(item,1,record||'{"amount_minor":"1"}',false,gen_random_uuid());
    raise exception 'Inconsistent holding valuation accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.edit_wealth_item(gen_random_uuid(),0,record||'{"kind":"asset","currency_code":"ZZZ","quantity_text":null,"unit_price_text":null,"amount_minor":"1"}',false,gen_random_uuid());
    raise exception 'Unsupported currency accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.edit_wealth_item(item,1,record||'{"cost_basis_minor":9007199254740000}',false,gen_random_uuid());
    raise exception 'Numeric JSON money accepted';
  exception when sqlstate '22023' then null; end;
  perform public.undo_wealth_event(event,1);
  if not exists(select 1 from public.wealth_items where id=item and removed_at is not null and amount_minor=9007199254740993) then raise exception 'Undo must preserve original wealth source'; end if;
  result:=public.edit_wealth_item(item,2,record||jsonb_build_object('linked_account_id',account),false,gen_random_uuid());
  perform public.undo_wealth_event((result->>'eventId')::uuid,3);
  if not exists(select 1 from public.wealth_items where id=item and removed_at is not null and linked_account_id is null) then raise exception 'Undo did not restore prior source'; end if;
  debt:=record||jsonb_build_object('kind','debt','name','Loan','amount_minor','-10000','quantity_text',null,'unit_price_text',null,'cost_basis_minor',null,'annual_rate_text','12','monthly_payment_minor','6000','next_payment_on','2026-10-02','payment_account_id',account);
  insert into public.accounts(id,workspace_id,name,currency_code) values(other_account,workspace,'Foreign currency cash','USD');
  begin
    perform public.edit_wealth_item(gen_random_uuid(),0,debt||jsonb_build_object('payment_account_id',other_account),false,gen_random_uuid());
    raise exception 'Debt cross-currency payment account accepted';
  exception when sqlstate 'P0002' then null; end;
  insert into public.financial_assumptions(id,workspace_id,account_id,name,kind,amount_minor,currency_code,cadence,starts_on,source,confirmed,enabled)
    values(assumption,workspace,account,'Loan repayment','expense',-6000,'EUR','monthly','2026-10-02','user',true,true);
  result:=public.create_manual_transaction(account,'2026-10-02','Pending loan repayment','-6000','pending',null,'',gen_random_uuid()); pending:=(result->>'id')::uuid;
  result:=public.edit_wealth_item(gen_random_uuid(),0,debt||jsonb_build_object('payment_assumption_id',assumption,'payment_transaction_id',pending),false,gen_random_uuid());
  if not exists(select 1 from public.wealth_items where id=(result->>'itemId')::uuid and amount_minor=-10000 and monthly_payment_minor=6000 and payment_assumption_id=assumption and payment_transaction_id=pending) then raise exception 'Explicit debt provenance links lost'; end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.edit_wealth_item(item,4,record,false,gen_random_uuid());
    raise exception 'Foreign wealth edit accepted';
  exception when sqlstate 'P0002' then null; end;
  execute 'set local role authenticated';
  if exists(select 1 from public.wealth_items where workspace_id=workspace) or exists(select 1 from public.wealth_events where workspace_id=workspace) then raise exception 'Foreign wealth evidence exposed'; end if;
  execute 'reset role';
end;
$$;
