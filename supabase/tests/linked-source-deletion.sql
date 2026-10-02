do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; cash uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); expense uuid; credit uuid; result jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-delete-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(cash,workspace,'Source','EUR'),(other,workspace,'Other','EUR');
  result:=public.create_manual_transaction(cash,'2026-10-01','Legacy original expense','-10000','posted',null,'',gen_random_uuid()); expense:=(result->>'id')::uuid;
  result:=public.create_manual_transaction(cash,'2026-10-02','Legacy partial refund','1000','posted',null,'',gen_random_uuid()); credit:=(result->>'id')::uuid;
  perform public.mark_transaction_refund(credit,0,expense);
  begin
    delete from public.transactions where id=expense;
    raise exception 'Legacy refund original deletion erased attribution';
  exception when sqlstate '22023' then null; end;
  if not exists(select 1 from public.transactions where id=credit and refund_of_id=expense) then raise exception 'Refund source attribution lost'; end if;
  result:=public.create_manual_transaction(cash,'2026-10-02','Untouched manual entry','-100','posted',null,'',gen_random_uuid());
  perform public.undo_manual_transaction((result->>'entryId')::uuid,0,0);
  if exists(select 1 from public.transactions where id=(result->>'id')::uuid) then raise exception 'Valid manual tombstone undo prevented'; end if;
end;
$$;
