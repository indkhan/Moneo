-- Exact saved-rule ownership/version guards in a nonce-private rollback schema.
do $$
declare actor uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid(); workspace uuid; other_workspace uuid;
  merchant uuid:=gen_random_uuid(); category uuid:=gen_random_uuid(); foreign_category uuid:=gen_random_uuid(); result jsonb; rule uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(stranger,'qa-'||stranger||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict other_workspace from public.workspaces where owner_id=stranger;
  insert into public.merchants(id,workspace_id,name,normalized_name) values(merchant,workspace,'Northstar Market','northstar market');
  insert into public.categories(id,workspace_id,name) values(category,workspace,'Groceries'),(foreign_category,other_workspace,'Foreign');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  result:=public.save_organization_rule(workspace,'northstar market',merchant,category,true,0);
  rule:=(result->>'id')::uuid;
  if result->>'version'<>'1' or not exists(select 1 from public.organization_rules where id=rule and approved_by=actor and enabled and merchant_id=merchant and category_id=category) then raise exception 'Approved rule was not persisted exactly'; end if;
  begin
    perform public.save_organization_rule(workspace,'northstar market',merchant,foreign_category,true,1);
    raise exception 'Foreign rule category accepted';
  exception when sqlstate 'P0002' then null; end;
  begin
    perform public.save_organization_rule(workspace,'northstar market',merchant,category,false,0);
    raise exception 'Stale rule update accepted';
  exception when sqlstate '40001' then null; end;
  result:=public.save_organization_rule(workspace,'northstar market',merchant,category,false,1);
  if result->>'version'<>'2' or exists(select 1 from public.organization_rules where id=rule and enabled) then raise exception 'Rule disable lost versioned intent'; end if;
  perform public.save_organization_rule(workspace,'northstar market',merchant,category,true,2);
  if (select count(*) from public.organization_rules where workspace_id=workspace)<>1 then raise exception 'Rule update duplicated identity'; end if;
  perform set_config('request.jwt.claim.sub',stranger::text,true);
  begin
    perform public.save_organization_rule(workspace,'northstar market',merchant,category,false,3);
    raise exception 'Foreign workspace rule changed';
  exception when sqlstate 'P0002' then null; end;
  set local role authenticated;
  if exists(select 1 from public.organization_rules where workspace_id=workspace) then raise exception 'Rule ownership policy leaked'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  set local role authenticated;
  if (select count(*) from public.organization_rules where workspace_id=workspace)<>1 then raise exception 'Owned rules unreadable'; end if;
  begin
    update public.organization_rules set enabled=false where id=rule;
    raise exception 'Direct rule writes bypassed approval/version guard';
  exception when insufficient_privilege then null; end;
  reset role;
end $$;
