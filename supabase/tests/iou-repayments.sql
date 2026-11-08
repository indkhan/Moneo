-- Loan repayments are durable links: dated by the bank row, capped by the receipt, undone with the Wealth change.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); first_loan uuid:=gen_random_uuid(); second_loan uuid:=gen_random_uuid(); receipt uuid; voided uuid; result jsonb; repayment uuid; event uuid; request uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-repay-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Repay cash','EUR');
  insert into public.wealth_items(id,workspace_id,kind,name,currency_code,amount_minor,as_of) values(first_loan,workspace,'asset','Lent to Sam','EUR',10000,'2026-09-01'),(second_loan,workspace,'asset','Lent to Sam Two','EUR',10000,'2026-09-01');
  insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values(workspace,account,'2026-10-05','From Sam',6000,'EUR','posted','ordinary') returning id into receipt;
  insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values(workspace,account,'2026-10-06','From Sam',100,'EUR','pending','ordinary') returning id into voided;

  result:=public.apply_iou_repayment(first_loan,receipt,6000,request);
  repayment:=(result->>'id')::uuid;
  if not exists(select 1 from public.wealth_items where id=first_loan and amount_minor=4000 and as_of='2026-10-05' and removed_at is null) then raise exception 'Partial repayment not dated by the bank row'; end if;
  if public.apply_iou_repayment(first_loan,receipt,6000,request)->>'id'<>repayment::text or (select amount_minor from public.wealth_items where id=first_loan)<>4000 then raise exception 'Retry applied twice'; end if;
  -- One receipt can't settle another loan beyond its amount.
  begin perform public.apply_iou_repayment(second_loan,receipt,1,gen_random_uuid()); raise exception 'Receipt reused' using errcode='ZX001'; exception when invalid_parameter_value then null; end;
  -- Only posted money counts.
  begin perform public.apply_iou_repayment(second_loan,voided,100,gen_random_uuid()); raise exception 'Unposted money used' using errcode='ZX001'; exception when invalid_parameter_value then null; end;

  -- Undoing the Wealth change frees the receipt.
  select wealth_event_id into strict event from public.iou_repayments where id=repayment;
  perform public.undo_wealth_event(event,(select version from public.wealth_items where id=first_loan));
  if (select undone_at from public.iou_repayments where id=repayment) is null then raise exception 'Undo left the link active'; end if;
  if not exists(select 1 from public.wealth_items where id=first_loan and amount_minor=10000 and as_of='2026-09-01') then raise exception 'Undo did not restore the loan'; end if;

  -- The receipt is free again for another loan.
  result:=public.apply_iou_repayment(second_loan,receipt,6000,gen_random_uuid());
  -- A later bank correction is visible by comparing the saved state, and can be confirmed if it still covers the repayment.
  update public.transactions set amount_minor=7000,posted_on='2026-10-07' where id=receipt;
  perform public.confirm_iou_repayment((result->>'id')::uuid);
  if not exists(select 1 from public.iou_repayments where id=(result->>'id')::uuid and transaction_amount_minor=7000 and transaction_posted_on='2026-10-07') then raise exception 'Confirmation did not save the new state'; end if;
  update public.transactions set amount_minor=-1 where id=receipt;
  begin perform public.confirm_iou_repayment((result->>'id')::uuid); raise exception 'Wrong-way payment confirmed' using errcode='ZX001'; exception when invalid_parameter_value then null; end;
  update public.transactions set amount_minor=6000 where id=receipt;
  if has_table_privilege('authenticated','public.iou_repayments','insert') then raise exception 'Owners must not write repayment links directly'; end if;

  -- Settling in full removes the loan as of the bank's date.
  declare full_loan uuid:=gen_random_uuid(); full_receipt uuid; begin
    insert into public.wealth_items(id,workspace_id,kind,name,currency_code,amount_minor,as_of) values(full_loan,workspace,'asset','Lent to Full','EUR',500,'2026-09-01');
    insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values(workspace,account,'2026-10-08','From Full',500,'EUR','posted','ordinary') returning id into full_receipt;
    perform public.apply_iou_repayment(full_loan,full_receipt,500,gen_random_uuid());
    if not exists(select 1 from public.wealth_items where id=full_loan and (removed_at at time zone 'Europe/Berlin')::date='2026-10-08') then raise exception 'Full settlement not dated by the bank row'; end if;
  end;
end;
$$;
