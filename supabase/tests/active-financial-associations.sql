do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid; obligation uuid; scenario uuid; debt uuid; event uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.accounts(workspace_id,name,currency_code) values(workspace,'Active obligation account','EUR') returning id into account;
  insert into public.financial_assumptions(workspace_id,account_id,name,amount_minor,currency_code,kind,cadence,starts_on,source)
    values(workspace,account,'Existing obligation',-100,'EUR','expense','monthly','2026-10-01','user') returning id into obligation;
  insert into public.wealth_items(id,workspace_id,kind,name,currency_code,amount_minor,as_of,payment_account_id)
    values(gen_random_uuid(),workspace,'debt','Existing debt','EUR',-10000,'2026-10-01',account) returning id into debt;
  insert into public.scenarios(workspace_id,name) values(workspace,'Synthetic scenario') returning id into scenario;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  perform public.edit_money_metadata('account',account,1,'{"archived":true}',gen_random_uuid());
  execute 'reset role';
  begin
    insert into public.financial_assumptions(workspace_id,account_id,name,amount_minor,currency_code,kind,cadence,starts_on,source)
      values(workspace,account,'New archived obligation',-100,'EUR','expense','monthly','2026-10-01','user');
    raise exception 'New assumption accepted archived account' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    insert into public.scenario_overrides(workspace_id,scenario_id,account_id,name,amount_delta_minor,currency_code,cadence,starts_on)
      values(workspace,scenario,account,'New archived scenario event',-100,'EUR','once','2026-10-01');
    raise exception 'New scenario accepted archived account' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    insert into public.wealth_items(id,workspace_id,kind,name,currency_code,amount_minor,as_of,payment_account_id)
      values(gen_random_uuid(),workspace,'debt','New archived debt','EUR',-10000,'2026-10-01',account);
    raise exception 'New debt accepted archived repayment account' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  -- Existing obligations can still be reduced/removed and restored by their audited APIs.
  execute 'set local role authenticated';
  event:=public.edit_assumption(obligation,1,'{"enabled":false}',gen_random_uuid());
  perform public.undo_planning_event(event,2);
  execute 'reset role';
  update public.wealth_items set name='Existing debt remains editable' where id=debt;
  if not exists(select 1 from public.financial_assumptions where id=obligation and enabled) then raise exception 'Archived obligation undo trapped'; end if;
end;
$$;
