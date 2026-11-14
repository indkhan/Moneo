-- Owner confirmation of AI labels and removal of organizer memory. Synthetic data only; the runner rolls this back.
do $$
declare actor uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); food uuid:=gen_random_uuid();
  r1 uuid:=gen_random_uuid(); r2 uuid:=gen_random_uuid(); ident uuid; memory uuid; op uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(stranger,'qa-'||stranger||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Surfaces','EUR');
  insert into public.categories(id,workspace_id,name) values(food,workspace,'Synthetic food');
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code)
    select id,workspace,account,'2026-10-01','CAFE LUNA '||n,-450,'EUR' from unnest(array[r1,r2]) with ordinality as source(id,n);
  perform public.apply_ai_organization(workspace,null,jsonb_build_array(
    jsonb_build_object('transaction_id',r1,'expected_version',0,'category_id',food,'confidence','high','identity_key','cafe luna'),
    jsonb_build_object('transaction_id',r2,'expected_version',0,'category_id',food,'confidence','high','identity_key','cafe luna','source','rule')));
  select id into strict op from public.organizer_ops where transaction_id=r1;

  -- Only the owner confirms, and only AI labels: the rule's row is left alone.
  perform set_config('request.jwt.claim.sub',stranger::text,true);
  if public.confirm_ai_organization(array[r1,r2])<>0 or (select organized_by from public.transactions where id=r1)<>'ai' then raise exception 'A stranger confirmed AI labels'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  if public.confirm_ai_organization(array[r1,r2])<>1 then raise exception 'Wrong rows confirmed'; end if;
  if exists(select 1 from public.transactions where id=r1 and (organized_by<>'owner' or ai_confidence is not null or ai_reason is not null or organize_op_id is not null or category_id<>food or version<>1))
    or (select organized_by from public.transactions where id=r2)<>'rule' then raise exception 'Confirmation changed the wrong fields'; end if;
  -- A confirmed label is the owner's: the AI undo no longer touches it, and the op record stays.
  if (public.undo_ai_organization(array[op])->>'skipped')<>'1' or (select category_id from public.transactions where id=r1)<>food
    or not exists(select 1 from public.organizer_ops where id=op) then raise exception 'Undo overrode a confirmed label'; end if;

  -- Memory: removal is the owner's; the labels it wrote stay.
  insert into public.organize_identities(workspace_id,kind,display_name) values(workspace,'merchant','Cafe Luna') returning id into ident;
  insert into public.organize_memory(workspace_id,identity_id,category_id,source,confirmed_at) values(workspace,ident,food,'owner',now()) returning id into memory;
  perform set_config('request.jwt.claim.sub',stranger::text,true);
  begin
    perform public.remove_organize_memory(memory);
    raise exception 'Foreign memory removed' using errcode='ZX001';
  exception when sqlstate 'P0002' then null; end;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform public.remove_organize_memory(memory);
  if exists(select 1 from public.organize_memory where id=memory) or (select category_id from public.transactions where id=r1)<>food then raise exception 'Memory removal went wrong'; end if;
end $$;
