do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); category uuid:=gen_random_uuid();
  transaction_id uuid; selection jsonb; review jsonb; applied jsonb; request uuid:=gen_random_uuid(); review_id uuid; stale_id uuid; dismissed uuid; original jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Organization review','EUR');
  insert into public.categories(id,workspace_id,name) values(category,workspace,'Groceries');
  transaction_id:=(public.create_manual_transaction(account,'2026-09-03','NORTHSTAR MARKET REF:781','-9007199254740993','posted',null,'',gen_random_uuid())->>'id')::uuid;
  select to_jsonb(t)-array['version','merchant_id','category_id'] into original from public.transactions t where id=transaction_id;
  selection:=jsonb_build_array(jsonb_build_object('id',transaction_id,'version',0));
  review:=public.create_organization_review(selection,jsonb_build_object('category_id',category),'Northstar Market','northstar market','[]',request);
  review_id:=(review->>'id')::uuid;
  if public.create_organization_review(selection,jsonb_build_object('category_id',category),'Northstar Market','northstar market','[]',request)<>review then raise exception 'Review retry duplicated identity'; end if;
  if not exists(select 1 from public.organization_reviews where id=review_id and status='pending' and snapshots->0->>'amount_minor'='-9007199254740993') then raise exception 'Durable review lost exact history'; end if;
  if exists(select 1 from public.transactions where id=transaction_id and (version<>0 or merchant_id is not null or category_id is not null)) then raise exception 'Creating review modified financial records'; end if;
  stale_id:=(public.create_organization_review(selection,jsonb_build_object('category_id',category),null,null,'[]',gen_random_uuid())->>'id')::uuid;
  applied:=public.apply_organization_review(review_id,true);
  if public.apply_organization_review(review_id,true)<>applied then raise exception 'Approval retry duplicated effects'; end if;
  if (select count(*) from public.organization_rules where workspace_id=workspace and description_key='northstar market' and category_id=category)<>1 then raise exception 'Approved rule missing'; end if;
  if (select to_jsonb(t)-array['version','merchant_id','category_id'] from public.transactions t where id=transaction_id)<>original then raise exception 'Organization changed financial truth'; end if;
  begin
    perform public.apply_organization_review(stale_id,false);
    raise exception 'Stale durable review applied';
  exception when sqlstate '40001' then null; end;
  if not exists(select 1 from public.organization_reviews where id=stale_id and status='pending') then raise exception 'Failed review approval partially persisted'; end if;
  perform public.dismiss_organization_review(stale_id);
  begin
    perform public.apply_organization_review(stale_id,false);
    raise exception 'Dismissed review applied';
  exception when sqlstate '22023' then null; end;
  -- The existing individual Transactions Undo must not split an approved batch/rule.
  begin
    perform public.undo_transaction_metadata((select id from public.correction_events where after->>'batch_id'=applied->>'batchId'),1);
    raise exception 'Individual metadata Undo bypassed organization batch/rule';
  exception when sqlstate '22023' then null; end;
  if exists(select 1 from public.transactions where id=transaction_id and version<>1) or not exists(select 1 from public.organization_rules where workspace_id=workspace and enabled) then raise exception 'Rejected individual Undo partially wrote'; end if;
  perform public.undo_transaction_batch((applied->>'batchId')::uuid,jsonb_build_array(jsonb_build_object('id',transaction_id,'version',1)));
  if not exists(select 1 from public.transactions where id=transaction_id and merchant_id is null and category_id is null and version=2) then raise exception 'Durable review batch Undo lost metadata'; end if;
  if exists(select 1 from public.organization_rules where workspace_id=workspace and enabled) then raise exception 'Atomic organization Undo retained its new active rule'; end if;
  if (public.apply_organization_review(review_id,true)->>'undone')::boolean is distinct from true then raise exception 'Approval retry concealed an undone batch'; end if;
  -- A rule changed after preview must cause approval, merchant creation and metadata to roll back together.
  select jsonb_build_array(jsonb_build_object('id',id,'version',version)) into selection from public.transactions where id=transaction_id;
  review_id:=(public.create_organization_review(selection,jsonb_build_object('category_id',category),'Alternative Merchant','northstar market','[]',gen_random_uuid())->>'id')::uuid;
  perform public.save_organization_rule(workspace,'northstar market',null,category,false,2);
  begin
    perform public.apply_organization_review(review_id,true);
    raise exception 'Changed approval rule silently overwritten';
  exception when sqlstate '40001' then null; end;
  if exists(select 1 from public.merchants where workspace_id=workspace and normalized_name='alternative merchant') or exists(select 1 from public.transactions where id=transaction_id and version<>2) then raise exception 'Rejected rule approval partially wrote'; end if;
  -- Replacing an existing disabled rule then undoing must restore its prior target and intent.
  review_id:=(public.create_organization_review(selection,jsonb_build_object('category_id',category),'Replacement Merchant','northstar market','[]',gen_random_uuid())->>'id')::uuid;
  applied:=public.apply_organization_review(review_id,true);
  perform public.undo_transaction_batch((applied->>'batchId')::uuid,jsonb_build_array(jsonb_build_object('id',transaction_id,'version',3)));
  if not exists(select 1 from public.organization_rules where workspace_id=workspace and description_key='northstar market' and not enabled and merchant_id is null and category_id=category and version=5) then raise exception 'Undo lost the existing approved rule state'; end if;
  -- A later rule edit fences the whole batch Undo before any metadata is restored.
  selection:=jsonb_build_array(jsonb_build_object('id',transaction_id,'version',4));
  review_id:=(public.create_organization_review(selection,jsonb_build_object('category_id',category),'Newest Merchant','northstar market','[]',gen_random_uuid())->>'id')::uuid;
  applied:=public.apply_organization_review(review_id,true);
  perform public.save_organization_rule(workspace,'northstar market',null,category,false,6);
  begin
    perform public.undo_transaction_batch((applied->>'batchId')::uuid,jsonb_build_array(jsonb_build_object('id',transaction_id,'version',5)));
    raise exception 'Batch Undo overwrote a later rule edit';
  exception when sqlstate '40001' then null; end;
  if exists(select 1 from public.transactions where id=transaction_id and version<>5) or exists(select 1 from public.transaction_batches where id=(applied->>'batchId')::uuid and undone) then raise exception 'Fenced rule Undo partially restored metadata'; end if;
  set local role authenticated;
  begin
    update public.organization_reviews set patch='{}' where id=review_id;
    raise exception 'Direct review writes bypassed frozen history';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.apply_organization_review(review_id,true);
    raise exception 'Foreign review approval accepted';
  exception when sqlstate 'P0002' then null; end;
  set local role authenticated;
  if exists(select 1 from public.organization_reviews where workspace_id=workspace) then raise exception 'Review history leaked across owners'; end if;
  reset role;
end $$;
