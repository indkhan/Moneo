-- Candidate until migration041 is independently reviewed; always executed in rollback.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; eur uuid:=gen_random_uuid(); usd uuid:=gen_random_uuid(); debit uuid; credit uuid; original uuid; refund uuid; first_refund uuid; refund_link uuid; rate uuid:=gen_random_uuid(); result jsonb; link uuid; request uuid:=gen_random_uuid(); ids uuid[]:='{}'; recurring public.recurring_series%rowtype; counter uuid; n integer; imported uuid:=gen_random_uuid(); source_row_id uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-links-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(eur,workspace,'EUR source','EUR'),(usd,workspace,'USD source','USD');
  insert into public.fx_rates(id,workspace_id,from_currency,to_currency,rate_text,rate_date,source) values(rate,workspace,'EUR','USD','1.1','2026-10-01','Owned dated test evidence');
  result:=public.create_manual_transaction(eur,'2026-10-02','FX debit with included fee','-10100','posted',null,'',gen_random_uuid()); debit:=(result->>'id')::uuid;
  result:=public.create_manual_transaction(usd,'2026-10-02','FX credit','11000','posted',null,'',gen_random_uuid()); credit:=(result->>'id')::uuid;
  result:=public.link_transactions('transfer',debit,0,credit,0,rate,jsonb_build_array(jsonb_build_object('transaction_id',debit,'fee_minor','100','treatment','included','category_id',null,'note','Explicit source fee')),request); link:=(result->>'linkId')::uuid;
  if public.link_transactions('transfer',debit,0,credit,0,rate,jsonb_build_array(jsonb_build_object('transaction_id',debit,'fee_minor','100','treatment','included','category_id',null,'note','Explicit source fee')),request)<>result then raise exception 'Verified link retry duplicated evidence'; end if;
  if not exists(select 1 from public.transactions where id=debit and amount_minor=-10100 and currency_code='EUR' and kind='transfer' and transfer_id=credit) then raise exception 'Canonical FX source changed'; end if;
  if (select sum(amount_minor) from public.effective_transactions where parent_transaction_id=debit and kind='ordinary')<>-100 then raise exception 'Included transfer fee expense lost'; end if;
  if (select count(*) from public.transaction_link_fees where link_id=link)<>1 then raise exception 'Fee evidence duplicated'; end if;
  begin
    perform public.undo_transaction_link(link,jsonb_build_array(jsonb_build_object('id',debit,'version',0),jsonb_build_object('id',credit,'version',1)));
    raise exception 'Stale pair undo accepted';
  exception when sqlstate '40001' then null; end;
  perform public.undo_transaction_link(link,jsonb_build_array(jsonb_build_object('id',debit,'version',1),jsonb_build_object('id',credit,'version',1)));
  if exists(select 1 from public.transactions where id in(debit,credit) and kind<>'ordinary') or exists(select 1 from public.effective_transactions where parent_transaction_id=debit and id<>debit) then raise exception 'Pair undo left active classifications or fee expenses'; end if;
  if not exists(select 1 from public.transaction_link_fees where link_id=link) then raise exception 'Undo destroyed fee source evidence'; end if;
  result:=public.create_manual_transaction(eur,'2026-10-02','Transfer debit excluding fee','-10000','posted',null,'',gen_random_uuid()); debit:=(result->>'id')::uuid;
  result:=public.create_manual_transaction(usd,'2026-10-02','Transfer credit excluding fee','11000','posted',null,'',gen_random_uuid()); credit:=(result->>'id')::uuid;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash) values(imported,workspace,'qa.csv','qa-private/'||imported,imported::text);
  insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,fee_evidence) values(source_row_id,workspace,imported,1,'{"Fee":"-1.00"}','{"feeMinor":"100","treatment":"additional"}');
  insert into public.transaction_sources(transaction_id,source_transaction_id) values(debit,source_row_id);
  update public.transactions set review_reasons=array['source_transfer','fee_semantics'] where id=debit;
  begin
    perform public.link_transactions('transfer',debit,0,credit,0,rate,'[]',gen_random_uuid());
    raise exception 'Known source fee silently suppressed';
  exception when sqlstate '22023' then null; end;
  result:=public.link_transactions('transfer',debit,0,credit,0,rate,jsonb_build_array(jsonb_build_object('transaction_id',debit,'fee_minor','100','treatment','additional','category_id',null,'note','Source column Fee -1.00')),gen_random_uuid());
  link:=(result->>'linkId')::uuid;
  if not exists(select 1 from public.transactions where id=debit and amount_minor=-10000 and review_reasons='{}') then raise exception 'Additional fee mutated canonical source or review not resolved'; end if;
  if (select sum(amount_minor) from public.effective_transactions where parent_transaction_id=debit and kind='ordinary')<>-100 then raise exception 'Additional fee expense disappeared'; end if;
  perform public.undo_transaction_link(link,jsonb_build_array(jsonb_build_object('id',debit,'version',1),jsonb_build_object('id',credit,'version',1)));
  if not exists(select 1 from public.transactions where id=debit and review_reasons=array['source_transfer','fee_semantics']) then raise exception 'Undo lost original review evidence'; end if;
  result:=public.create_manual_transaction(usd,'2026-09-01','Original USD expense','-11000','posted',null,'',gen_random_uuid()); original:=(result->>'id')::uuid;
  result:=public.create_manual_transaction(eur,'2026-10-02','Partial EUR refund one','5000','posted',null,'',gen_random_uuid()); refund:=(result->>'id')::uuid;
  first_refund:=refund;
  update public.transactions set review_reasons=array['refund_sign'] where id=refund;
  update public.transactions set review_reasons=array['source_type'] where id=original;
  begin
    perform public.link_transactions('refund',refund,0,original,0,rate,'[]',gen_random_uuid());
    raise exception 'Unreviewed original classified as refundable expense';
  exception when sqlstate '22023' then null; end;
  update public.transactions set review_reasons='{}' where id=original;
  result:=public.link_transactions('refund',refund,0,original,0,rate,'[]',gen_random_uuid());
  refund_link:=(result->>'linkId')::uuid;
  if not exists(select 1 from public.transactions where id=refund and amount_minor=5000 and currency_code='EUR' and refund_of_id=original) then raise exception 'Refund posting currency altered'; end if;
  if not exists(select 1 from public.transactions where id=refund and review_reasons='{}') then raise exception 'Explicit positive refund sign stayed unresolved'; end if;
  result:=public.create_manual_transaction(eur,'2026-10-02','Partial refund two','5000','posted',null,'',gen_random_uuid()); refund:=(result->>'id')::uuid;
  perform public.link_transactions('refund',refund,0,original,0,rate,'[]',gen_random_uuid());
  update public.fx_rates set rate_text='9' where id=rate;
  if not exists(select 1 from public.transaction_links where id=refund_link and original_equivalent_minor=5500 and fx_evidence->>'rate_text'='1.1') then raise exception 'Later FX edit rewrote historical refund comparison'; end if;
  begin
    update public.transactions set kind='transfer' where id=original;
    raise exception 'Active refund original financial classification changed';
  exception when sqlstate '22023' then null; end;
  begin
    update public.transactions set amount_minor=-1 where id=original;
    raise exception 'Active refund original money reduced below credits';
  exception when sqlstate '22023' then null; end;
  update public.transactions set note='Original metadata remains editable' where id=original;
  result:=public.create_manual_transaction(eur,'2026-10-02','Excess refund','1','posted',null,'',gen_random_uuid()); refund:=(result->>'id')::uuid;
  begin
    perform public.link_transactions('refund',refund,0,original,0,rate,'[]',gen_random_uuid());
    raise exception 'Aggregate refund cap bypassed';
  exception when sqlstate '22023' then null; end;
  result:=public.create_manual_transaction(usd,'2026-10-02','Legacy excess refund','1','posted',null,'',gen_random_uuid()); refund:=(result->>'id')::uuid;
  begin
    perform public.mark_transaction_refund(refund,0,original);
    raise exception 'Legacy refund RPC bypassed aggregate cap';
  exception when sqlstate '22023' then null; end;
  perform public.undo_transaction_link(refund_link,jsonb_build_array(jsonb_build_object('id',first_refund,'version',1)));
  if not exists(select 1 from public.transactions where id=first_refund and review_reasons=array['refund_sign'] and refund_of_id is null) then raise exception 'Refund undo lost source sign flag'; end if;
  for n in 1..3 loop
    result:=public.create_manual_transaction(eur,('2026-07-02'::date+make_interval(months=>n-1))::date,'Monthly internal funding','-1000','posted',null,'',gen_random_uuid());
    ids:=array_append(ids,(result->>'id')::uuid);
  end loop;
  recurring:=public.confirm_recurring_series(eur,'Monthly internal funding','monthly','EUR',-1000,-1000,3,100,ids);
  result:=public.create_manual_transaction(eur,'2026-09-02','Other account transfer credit','1000','posted',null,'',gen_random_uuid()); counter:=(result->>'id')::uuid;
  -- Different account in the same currency.
  insert into public.accounts(workspace_id,name,currency_code) values(workspace,'Other EUR account','EUR') returning id into eur;
  update public.transactions set account_id=eur where id=counter;
  result:=public.link_transactions('transfer',ids[3],0,counter,0,null,'[]',gen_random_uuid()); link:=(result->>'linkId')::uuid;
  if exists(select 1 from public.financial_assumptions where id=recurring.assumption_id and enabled) then raise exception 'Reclassified recurring source remained active'; end if;
  if not exists(select 1 from public.recurring_series where id=recurring.id and evidence_invalidated) then raise exception 'Recurring source invalidation missing'; end if;
  begin
    update public.financial_assumptions set enabled=true,confirmed=true where id=recurring.assumption_id;
    raise exception 'Invalidated inferred assumption re-enabled without reviewed source';
  exception when sqlstate '22023' then null; end;
  perform public.undo_transaction_link(link,jsonb_build_array(jsonb_build_object('id',ids[3],'version',1),jsonb_build_object('id',counter,'version',1)));
  if not exists(select 1 from public.financial_assumptions where id=recurring.assumption_id and enabled and confirmed and source='recurring_confirmed') then raise exception 'Undo failed to restore unchanged recurring assumption'; end if;
  update public.financial_assumptions set source='user',amount_minor=-2500,enabled=true,confirmed=true where id=recurring.assumption_id;
  result:=public.link_transactions('transfer',ids[3],2,counter,2,null,'[]',gen_random_uuid()); link:=(result->>'linkId')::uuid;
  if not exists(select 1 from public.financial_assumptions where id=recurring.assumption_id and source='user' and amount_minor=-2500 and enabled) then raise exception 'Source correction overwrote intentional user assumption'; end if;
  perform public.undo_transaction_link(link,jsonb_build_array(jsonb_build_object('id',ids[3],'version',3),jsonb_build_object('id',counter,'version',3)));
  if not exists(select 1 from public.financial_assumptions where id=recurring.assumption_id and source='user' and amount_minor=-2500 and enabled) then raise exception 'Source undo overwrote intentional user assumption'; end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.undo_transaction_link(link,'[]');
    raise exception 'Foreign link undo accepted';
  exception when sqlstate 'P0002' then null; end;
  execute 'set local role authenticated';
  if exists(select 1 from public.transaction_links where workspace_id=workspace) or exists(select 1 from public.transaction_link_fees where workspace_id=workspace) then raise exception 'Foreign link evidence exposed'; end if;
  execute 'reset role';
end;
$$;
