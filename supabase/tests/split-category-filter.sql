do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); category uuid:=gen_random_uuid(); parent uuid; result jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Filter splits','EUR');
  insert into public.categories(id,workspace_id,name) values(category,workspace,'Food');
  result:=public.create_manual_transaction(account,'2026-10-01','Original split receipt','-1000','posted',null,'',gen_random_uuid());
  parent:=(result->>'id')::uuid;
  perform public.split_transaction(parent,0,jsonb_build_array(jsonb_build_object('amount_minor','-300','category_id',category,'note','First food'),jsonb_build_object('amount_minor','-200','category_id',category,'note','More food'),jsonb_build_object('amount_minor','-500','category_id',null,'note','Other')),gen_random_uuid());
  if (select count(*) from public.transaction_category_ledger where id=parent and category_id=category)<>1 then raise exception 'Category filter duplicated same parent allocations'; end if;
  if (select amount_minor from public.transaction_category_ledger where id=parent and category_id=category)<>-1000 then raise exception 'Filtered ledger must show canonical source amount once'; end if;
  if (select count(*) from public.transaction_category_ledger where id=parent and category_id is null)<>1 then raise exception 'Uncategorized allocation missing'; end if;
  execute 'set local role authenticated';
  if (select count(*) from public.transaction_category_ledger where id=parent and category_id=category)<>1 then raise exception 'Owner category filter inaccessible'; end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  execute 'set local role authenticated';
  if exists(select 1 from public.transaction_category_ledger where workspace_id=workspace) then raise exception 'Foreign filtered ledger exposed'; end if;
  execute 'reset role';
end;
$$;
