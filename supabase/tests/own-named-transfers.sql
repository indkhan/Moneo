do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); pocket_row uuid:=gen_random_uuid();
  marked public.transactions%rowtype; event_id uuid; restored public.transactions%rowtype;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Pocket EUR','EUR');
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,review_reasons)
    values(pocket_row,workspace,account,'2026-10-01','To EUR MB:00000000-0000-4000-8000-000000000000',-2000,'EUR','{source_transfer}');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  begin
    perform public.mark_own_named_transfer(pocket_row,0,'savings');
    raise exception 'Unknown own account accepted' using errcode='ZX001';
  exception when sqlstate '22023' then null; end;
  marked:=public.mark_own_named_transfer(pocket_row,0,'pocket');
  if marked.kind<>'transfer' or marked.transfer_id is not null or marked.version<>1 or marked.amount_minor<>-2000 or marked.review_reasons<>'{}' then
    raise exception 'Pocket move was not marked as an own transfer'; end if;
  select id into strict event_id from public.correction_events
  where transaction_id=pocket_row and after->>'rule'='pocket' and after->>'own_account'='Revolut pocket';
  restored:=public.undo_own_account_transfer(event_id,1);
  if restored.kind<>'ordinary' or restored.review_reasons<>'{source_transfer}' or restored.amount_minor<>-2000 then
    raise exception 'Undo did not restore the pocket move'; end if;
end $$;
