do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid; blocked_account uuid; goal uuid; view_id uuid; event uuid; archive_event uuid; request uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.accounts(workspace_id,name,currency_code) values(workspace,'Original','EUR') returning id into account;
  insert into public.accounts(workspace_id,name,currency_code) values(workspace,'Pending account','EUR') returning id into blocked_account;
  insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status) values(workspace,blocked_account,'2026-10-01','Pending debit',-100,'EUR','pending');
  insert into public.transaction_views(workspace_id,name) values(workspace,'Original view') returning id into view_id;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  begin
    perform public.edit_money_metadata('account',blocked_account,1,'{"archived":true}',gen_random_uuid());
    raise exception 'Archived account with pending hold' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  event:=public.edit_money_metadata('account',account,1,'{"name":"Renamed"}',request);
  if public.edit_money_metadata('account',account,1,'{"name":"Renamed"}',request)<>event then raise exception 'Metadata retry was not idempotent'; end if;
  begin
    perform public.edit_money_metadata('account',account,1,'{"name":"Different"}',request);
    raise exception 'Conflicting request accepted' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.edit_money_metadata('account',account,1,'{"name":"Stale"}',gen_random_uuid());
    raise exception 'Stale metadata edit accepted' using errcode='ZX001';
  exception when serialization_failure then null; end;
  archive_event:=public.edit_money_metadata('account',account,2,'{"archived":true}',gen_random_uuid());
  perform public.undo_money_metadata(archive_event,3,gen_random_uuid());
  perform public.undo_money_metadata(event,4,gen_random_uuid());
  if not exists(select 1 from public.accounts where id=account and name='Original' and version=5 and archived_at is null) then raise exception 'Sequential metadata undo lost original'; end if;
  perform public.edit_money_metadata('account',account,5,'{"archived":true}',gen_random_uuid());
  event:=public.edit_money_metadata('transaction_view',view_id,1,'{"removed":true}',gen_random_uuid());
  perform public.undo_money_metadata(event,2,gen_random_uuid());
  if not exists(select 1 from public.transaction_views where id=view_id and removed_at is null and version=3) then raise exception 'Saved view undo failed'; end if;
  execute 'reset role';
  delete from public.transactions where account_id=blocked_account;
  insert into public.goals(workspace_id,name,target_minor,currency_code) values(workspace,'Protected reservation',1000,'EUR') returning id into goal;
  insert into public.goal_allocations(workspace_id,goal_id,account_id,amount_minor) values(workspace,goal,blocked_account,100);
  execute 'set local role authenticated';
  begin
    perform public.edit_money_metadata('account',blocked_account,1,'{"archived":true}',gen_random_uuid());
    raise exception 'Archived account with reservation' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.edit_money_metadata('account',blocked_account,1,'{"type":"investment"}',gen_random_uuid());
    raise exception 'Reserved liquidity silently changed' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    update public.accounts set name='Bypass' where id=account;
    raise exception 'Direct mutation bypassed metadata audit' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  begin
    insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(workspace,account,'2026-10-01','Archived attempt',-100,'EUR');
    raise exception 'Archived account accepted new transaction' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    update public.accounts set currency_code='USD' where id=account;
    raise exception 'Account currency changed after creation' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
end;
$$;
