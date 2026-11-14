-- AI organization labels keep AI provenance: no owner corrections or rules, owner precedence, exact Undo.
-- Synthetic data only; the migration runner rolls this back.
do $$
declare actor uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid();
  food uuid:=gen_random_uuid(); fun uuid:=gen_random_uuid();
  r1 uuid:=gen_random_uuid(); r2 uuid:=gen_random_uuid(); r3 uuid:=gen_random_uuid(); r4 uuid:=gen_random_uuid(); r5 uuid:=gen_random_uuid(); r6 uuid:=gen_random_uuid();
  result jsonb; op uuid; batch jsonb; event_id uuid; tx public.transactions%rowtype;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(stranger,'qa-'||stranger||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Provenance','EUR');
  insert into public.categories(id,workspace_id,name) values(food,workspace,'Synthetic food'),(fun,workspace,'Synthetic fun');
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code)
    select id,workspace,account,'2026-10-01','CAFE LUNA '||n,-450,'EUR' from unnest(array[r1,r2,r3,r4,r5,r6]) with ordinality as source(id,n);
  -- r2 organized by the owner; r3 corrected by the owner before provenance existed; r4 split.
  update public.transactions set organized_by='owner' where id=r2;
  insert into public.correction_events(workspace_id,transaction_id,actor_id,before,after)
    values(workspace,r3,actor,jsonb_build_object('category_id',null,'version',0),jsonb_build_object('category_id',fun,'version',0));
  update public.transactions set organized_by=null where id=r3;
  insert into public.transaction_split_sets(workspace_id,transaction_id,request_id,actor_id,before,after) values(workspace,r4,gen_random_uuid(),actor,'{}','{}');

  result:=public.apply_ai_organization(workspace,null,jsonb_build_array(
    jsonb_build_object('transaction_id',r1,'expected_version',0,'category_id',food,'merchant_name','Luna Cafe','confidence','high','reason','Quoted “CAFE LUNA”','identity_key','cafe luna'),
    jsonb_build_object('transaction_id',r2,'expected_version',0,'category_id',food,'confidence','high','identity_key','cafe luna'),
    jsonb_build_object('transaction_id',r3,'expected_version',0,'category_id',food,'confidence','high','identity_key','cafe luna'),
    jsonb_build_object('transaction_id',r4,'expected_version',0,'category_id',food,'confidence','medium','identity_key','cafe luna'),
    jsonb_build_object('transaction_id',r5,'expected_version',7,'category_id',food,'confidence','medium','identity_key','cafe luna'),
    jsonb_build_object('transaction_id',r6,'expected_version',0,'category_id',food,'confidence','low','identity_key','cafe luna')));
  if result->>'applied'<>'1' or result->'skipped'<>'{"owner":1,"owner_corrected":1,"split":1,"changed":1,"low_confidence":1}'::jsonb
    then raise exception 'AI apply skipped the wrong rows: %',result; end if;
  select * into strict tx from public.transactions where id=r1;
  select id into strict op from public.organizer_ops where transaction_id=r1;
  if tx.category_id<>food or tx.organized_by<>'ai' or tx.ai_confidence<>'high' or tx.organize_op_id<>op or tx.version<>1
    or not exists(select 1 from public.merchants where id=tx.merchant_id and name='Luna Cafe' and created_by='ai') then raise exception 'AI provenance not written'; end if;
  if exists(select 1 from public.correction_events where transaction_id=r1) or exists(select 1 from public.organization_rules where workspace_id=workspace)
    then raise exception 'AI apply created owner corrections or rules'; end if;
  if exists(select 1 from public.transactions where id in (r2,r3,r4,r5,r6) and category_id is not null) then raise exception 'AI labelled a protected row'; end if;

  -- The owner relabels the AI row, then takes it back: AI provenance returns exactly.
  perform set_config('request.jwt.claim.sub',actor::text,true);
  batch:=public.bulk_edit_transactions(jsonb_build_array(jsonb_build_object('id',r1,'version',1)),jsonb_build_object('category_id',fun),gen_random_uuid());
  select * into strict tx from public.transactions where id=r1;
  if tx.organized_by<>'owner' or tx.ai_confidence is not null or tx.organize_op_id is not null or tx.category_id<>fun then raise exception 'Owner edit kept AI provenance'; end if;
  if not (select owner_touched from public.categories where id=fun) then raise exception 'Owner use did not touch the category'; end if;
  select id into strict event_id from public.correction_events where transaction_id=r1 and after->>'batch_id'=batch->>'batchId';
  perform public.undo_transaction_metadata(event_id,tx.version);
  select * into strict tx from public.transactions where id=r1;
  if tx.category_id<>food or tx.organized_by is distinct from 'ai' or tx.ai_confidence is distinct from 'high' or tx.organize_op_id is distinct from op
    then raise exception 'Undoing the owner edit lost AI provenance'; end if;
  -- A tag-only edit leaves provenance alone.
  perform public.bulk_edit_transactions(jsonb_build_array(jsonb_build_object('id',r1,'version',tx.version)),'{"tags":["trip"]}',gen_random_uuid());
  if (select organized_by from public.transactions where id=r1)<>'ai' then raise exception 'Tag edit took over AI provenance'; end if;

  -- Undo of the AI op: only the owner, restores the blank row and suppresses the suggestion.
  perform set_config('request.jwt.claim.sub',stranger::text,true);
  begin
    perform public.undo_ai_organization(array[op]);
    raise exception 'Foreign AI undo accepted';
  exception when sqlstate 'P0002' then null; end;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  -- An import bumping the version does not block Undo.
  update public.transactions set version=version+1 where id=r1;
  result:=public.undo_ai_organization(array[op]);
  select * into strict tx from public.transactions where id=r1;
  if result->>'undone'<>'1' or tx.category_id is not null or tx.merchant_id is not null or tx.organized_by is not null or tx.organize_op_id is not null
    or not exists(select 1 from public.organizer_ops where id=op and undone_at is not null and suppressed) then raise exception 'AI undo did not restore: %',result; end if;
  result:=public.apply_ai_organization(workspace,null,jsonb_build_array(jsonb_build_object('transaction_id',r1,'expected_version',tx.version,'category_id',food,
    'merchant_name','Luna Cafe','confidence','high','identity_key','cafe luna')));
  if result->>'applied'<>'0' or result->'skipped'<>'{"suppressed":1}'::jsonb then raise exception 'Undone suggestion came back: %',result; end if;
  result:=public.apply_ai_organization(workspace,null,jsonb_build_array(jsonb_build_object('transaction_id',r1,'expected_version',tx.version,'category_id',fun,
    'merchant_name','Luna Cafe','confidence','medium','identity_key','cafe luna')));
  select * into strict tx from public.transactions where id=r1;
  if result->>'applied'<>'1' or tx.category_id<>fun or tx.merchant_id is not null or tx.ai_confidence<>'medium' then raise exception 'A different suggestion was blocked: %',result; end if;
end $$;

-- The reset takes back what the old auto-apply (owner RPCs under the owner's id) stored, keeping owner edits.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); food uuid:=gen_random_uuid(); fun uuid:=gen_random_uuid(); m1 uuid:=gen_random_uuid();
  a1 uuid:=gen_random_uuid(); a2 uuid:=gen_random_uuid(); b1 uuid:=gen_random_uuid(); c1 uuid:=gen_random_uuid(); d1 uuid:=gen_random_uuid(); e1 uuid:=gen_random_uuid();
  run uuid:=gen_random_uuid(); pa uuid:=gen_random_uuid(); pb uuid:=gen_random_uuid(); pc uuid:=gen_random_uuid(); pd uuid:=gen_random_uuid(); pe uuid:=gen_random_uuid();
  review uuid; v integer; outcome jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Reset','EUR');
  insert into public.categories(id,workspace_id,name) values(food,workspace,'Synthetic food'),(fun,workspace,'Synthetic fun');
  insert into public.merchants(id,workspace_id,name,normalized_name) values(m1,workspace,'Owner Merchant','owner merchant');
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code)
    select id,workspace,account,'2026-10-01','SHOP '||n,-450,'EUR' from unnest(array[a1,a2,b1,c1,d1,e1]) with ordinality as source(id,n);
  insert into public.agent_runs(id,workspace_id) values(run,workspace);
  insert into public.agent_proposals(id,run_id,workspace_id,agent,kind,conflict_key,title,status,result)
    select id,run,workspace,'categorizer','categorize','categorize:'||id,'Synthetic',case when id=pd then 'applying' else 'accepted' end,
      case when id=pe then '{"href":"/money/organization"}'::jsonb when id=pd then null else '{"auto":true}'::jsonb end from unnest(array[pa,pb,pc,pd,pe]) id;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  -- An owner rule that auto-apply later overwrote, plus the old auto-apply itself.
  perform public.save_organization_rule(workspace,'restore key',m1,fun,true,0);
  review:=(public.create_organization_review(jsonb_build_array(jsonb_build_object('id',a1,'version',0),jsonb_build_object('id',a2,'version',0)),jsonb_build_object('category_id',food),'Northwind Shop','northwind shop','[]',pa)->>'id')::uuid;
  perform public.apply_organization_review(review,true);
  review:=(public.create_organization_review(jsonb_build_array(jsonb_build_object('id',b1,'version',0)),'{}','Gone Merchant',null,'[]',pb)->>'id')::uuid;
  perform public.apply_organization_review(review,false);
  review:=(public.create_organization_review(jsonb_build_array(jsonb_build_object('id',c1,'version',0)),jsonb_build_object('category_id',food),null,'restore key','[]',pc)->>'id')::uuid;
  perform public.apply_organization_review(review,true);
  review:=(public.create_organization_review(jsonb_build_array(jsonb_build_object('id',d1,'version',0)),jsonb_build_object('category_id',food),null,'keep key','[]',pd)->>'id')::uuid;
  perform public.apply_organization_review(review,true);
  -- The owner's own accepted card is not auto-apply and stays.
  review:=(public.create_organization_review(jsonb_build_array(jsonb_build_object('id',e1,'version',0)),jsonb_build_object('category_id',food),null,null,'[]',pe)->>'id')::uuid;
  perform public.apply_organization_review(review,false);
  -- Later: an import bumps a1, the owner recategorizes a2 and edits the 'keep key' rule.
  update public.transactions set version=version+1 where id=a1;
  select t.version into v from public.transactions t where id=a2;
  perform public.correct_transaction(a2,v,'Owner pick','');
  perform public.save_organization_rule(workspace,'keep key',null,fun,true,(select r.version from public.organization_rules r where workspace_id=workspace and description_key='keep key'));

  outcome:=public.reset_auto_organization();
  if exists(select 1 from public.transactions where id in (a1,b1,c1,d1) and (category_id is not null or merchant_id is not null or organized_by is not null))
    then raise exception 'Auto-applied rows were not restored: %',outcome; end if;
  if exists(select 1 from public.correction_events where transaction_id in (a1,b1,c1,d1) and not undone) then raise exception 'Restored events still active'; end if;
  if (select category_id from public.transactions where id=a2) is distinct from (select id from public.categories where workspace_id=workspace and name='Owner pick')
    or (select merchant_id from public.transactions where id=a2) is null then raise exception 'Owner-edited row was reverted'; end if;
  if not exists(select 1 from public.correction_events where transaction_id=a2 and origin='ai' and not undone and after->>'operation'='metadata')
    or not exists(select 1 from public.correction_events where transaction_id=a2 and origin='owner' and not undone) then raise exception 'Kept auto-apply event was not stamped AI'; end if;
  if not exists(select 1 from public.merchants where workspace_id=workspace and name='Northwind Shop' and created_by='ai')
    or exists(select 1 from public.merchants where workspace_id=workspace and name='Gone Merchant')
    or not exists(select 1 from public.merchants where id=m1 and created_by='owner') then raise exception 'AI merchants not cleaned up'; end if;
  if exists(select 1 from public.organization_rules where workspace_id=workspace and description_key='northwind shop')
    or not exists(select 1 from public.organization_rules where workspace_id=workspace and description_key='restore key' and category_id=fun and merchant_id=m1)
    or not exists(select 1 from public.organization_rules where workspace_id=workspace and description_key='keep key' and category_id=fun)
    then raise exception 'Rules not reset per owner edits: %',outcome; end if;
  if (select category_id from public.transactions where id=e1)<>food or (select status from public.agent_proposals where id=pe)<>'accepted' then raise exception 'Owner-accepted card was reset'; end if;
  if (select count(*) from public.agent_proposals where id in (pa,pb,pc,pd) and status='rejected' and result='{"reset":true}')<>4 then raise exception 'Reset proposals can apply again'; end if;
  if public.reset_auto_organization()->>'proposals'<>'0' then raise exception 'Reset is not idempotent'; end if;
end $$;

-- The organizer never relabels rows from the owner's memory or the owner's own rows, and its non-AI labels keep their source.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); food uuid:=gen_random_uuid();
  m1 uuid:=gen_random_uuid(); o1 uuid:=gen_random_uuid(); b1 uuid:=gen_random_uuid(); result jsonb; tx public.transactions%rowtype;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Sources','EUR');
  insert into public.categories(id,workspace_id,name) values(food,workspace,'Synthetic food');
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code)
    select id,workspace,account,'2026-10-01','MARKET '||n,-450,'EUR' from unnest(array[m1,o1,b1]) with ordinality as source(id,n);
  -- m1 has its category from the owner's memory but no merchant yet; o1 is the owner's.
  update public.transactions set organized_by='memory',category_id=food where id=m1;
  update public.transactions set organized_by='owner' where id=o1;
  result:=public.apply_ai_organization(workspace,null,jsonb_build_array(
    jsonb_build_object('transaction_id',m1,'expected_version',0,'merchant_name','Synthetic Market','confidence','high','identity_key','market'),
    jsonb_build_object('transaction_id',o1,'expected_version',0,'category_id',food,'confidence','high','identity_key','market','source','system'),
    jsonb_build_object('transaction_id',b1,'expected_version',0,'category_id',food,'confidence','high','reason','Bank: MCC 5411','identity_key','market','source','system')));
  if result->>'applied'<>'1' or result->'skipped'<>'{"memory":1,"owner":1}'::jsonb then raise exception 'Organizer touched owner or memory rows: %',result; end if;
  if (select merchant_id from public.transactions where id=m1) is not null or (select organized_by from public.transactions where id=m1)<>'memory'
    or (select category_id from public.transactions where id=o1) is not null then raise exception 'A protected row changed'; end if;
  select * into strict tx from public.transactions where id=b1;
  if tx.organized_by<>'system' or tx.ai_confidence is not null or tx.ai_reason<>'Bank: MCC 5411' or tx.category_id<>food
    or (select after->>'organized_by' from public.organizer_ops where transaction_id=b1)<>'system' then raise exception 'Bank label lost its source'; end if;
  begin
    perform public.apply_ai_organization(workspace,null,jsonb_build_array(jsonb_build_object('transaction_id',b1,'expected_version',1,'category_id',food,'confidence','high','identity_key','market','source','owner')));
    raise exception 'The organizer wrote as the owner';
  exception when sqlstate '22023' then null; end;
end $$;
