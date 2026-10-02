do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); category uuid:=gen_random_uuid(); parent uuid; result jsonb; request uuid:=gen_random_uuid(); set_id uuid; children jsonb; other uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Splits','EUR');
  insert into public.categories(id,workspace_id,name) values(category,workspace,'Food');
  result:=public.create_manual_transaction(account,'2026-10-01','Original receipt','-9007199254740993','posted',null,'Original note',gen_random_uuid());
  parent:=(result->>'id')::uuid;
  children:=jsonb_build_array(jsonb_build_object('amount_minor','-9007199254740000','category_id',category,'note','Food'),jsonb_build_object('amount_minor','-993','category_id',null,'note','Other'));
  begin
    perform public.split_transaction(parent,0,'[{"amount_minor":"-1","category_id":null,"note":""},{"amount_minor":"1","category_id":null,"note":""}]',gen_random_uuid());
    raise exception 'Wrong sum/sign accepted';
  exception when sqlstate '22023' then null; end;
  result:=public.split_transaction(parent,0,children,request);
  set_id:=(result->>'setId')::uuid;
  if public.split_transaction(parent,0,children,request)<>result then raise exception 'Split retry duplicated evidence'; end if;
  if (select sum(amount_minor) from public.transactions where id=parent)<>-9007199254740993 then raise exception 'Parent balance money changed'; end if;
  if (select count(*) from public.effective_transactions where parent_transaction_id=parent)<>2 or
     (select sum(amount_minor) from public.effective_transactions where parent_transaction_id=parent)<>-9007199254740993 then raise exception 'Effective spending double counted or lost precision'; end if;
  if exists(select 1 from public.effective_transactions where id=parent) then raise exception 'Split parent leaked into effective rows'; end if;
  if (select sum(amount_minor) from public.effective_transactions where parent_transaction_id=parent and category_id=category)<>-9007199254740000 then raise exception 'Allocation category wrong'; end if;
  if not exists(select 1 from public.transactions where id=parent and category_id is null and note='Original note' and version=1) then raise exception 'Original source/category changed'; end if;
  execute 'set local role authenticated';
  if (select count(*) from public.effective_transactions where parent_transaction_id=parent)<>2 then raise exception 'Owner effective allocations inaccessible'; end if;
  execute 'reset role';
  begin
    perform public.mark_transaction_refund(parent,1,null);
    raise exception 'Split parent linked/classified';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.undo_transaction_splits(set_id,0);
    raise exception 'Stale split undo accepted';
  exception when sqlstate '40001' then null; end;
  perform public.undo_transaction_splits(set_id,1);
  if not exists(select 1 from public.effective_transactions where id=parent and amount_minor=-9007199254740993) or
     exists(select 1 from public.effective_transactions where parent_transaction_id=parent and id<>parent) then raise exception 'Undo failed effective parent restore'; end if;
  if (select count(*) from public.transaction_splits where split_set_id=set_id)<>2 then raise exception 'Undo erased split evidence'; end if;
  begin
    perform public.undo_manual_transaction((select id from public.manual_transaction_entries where transaction_id=parent),0,2);
    raise exception 'Split historical evidence removed';
  exception when sqlstate '40001' then null; end;
  perform set_config('request.jwt.claim.sub',other::text,true);
  begin
    perform public.split_transaction(parent,2,children,gen_random_uuid());
    raise exception 'Foreign split accepted';
  exception when sqlstate 'P0002' then null; end;
  execute 'set local role authenticated';
  if exists(select 1 from public.effective_transactions where workspace_id=workspace) or exists(select 1 from public.transaction_splits where workspace_id=workspace) then raise exception 'Foreign effective or split evidence visible'; end if;
  execute 'reset role';
end;
$$;
