-- Identities, owner-confirmed memory, questions and exchange marks. Synthetic data only; the runner rolls this back.
do $$
declare actor uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); usd_account uuid:=gen_random_uuid();
  food uuid:=gen_random_uuid(); fun uuid:=gen_random_uuid(); shop uuid;
  t1 uuid:=gen_random_uuid(); t2 uuid:=gen_random_uuid(); t3 uuid:=gen_random_uuid(); t4 uuid:=gen_random_uuid(); t5 uuid:=gen_random_uuid();
  t6 uuid:=gen_random_uuid(); t7 uuid:=gen_random_uuid(); t8 uuid:=gen_random_uuid(); pay uuid:=gen_random_uuid(); e1 uuid:=gen_random_uuid(); e2 uuid:=gen_random_uuid();
  cafe uuid; processor uuid; bare_processor uuid; result jsonb; rows jsonb; asked uuid; again uuid; event_id uuid; tx public.transactions%rowtype;
  cafe_aliases jsonb:='[{"type":"counterparty_name","value":"cafe luna"},{"type":"description_key","value":"cafe luna"}]';
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(stranger,'qa-'||stranger||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Identity EUR','EUR'),(usd_account,workspace,'Identity USD','USD');
  insert into public.categories(id,workspace_id,name) values(food,workspace,'Synthetic food'),(fun,workspace,'Synthetic fun');
  insert into public.merchants(workspace_id,name,normalized_name) values(workspace,'Luna Cafe','luna cafe') returning id into shop;
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code)
    select id,workspace,account,'2026-10-01','CAFE LUNA '||n,-450,'EUR' from unnest(array[t1,t2,t3,t4,t5,t6,t7,t8,pay]) with ordinality as source(id,n);
  -- t2 labelled by the AI; t3 organized by the owner; t4 split; t5 corrected by the owner; t6 a transfer.
  update public.transactions set category_id=fun,organized_by='ai',ai_confidence='high' where id=t2;
  update public.transactions set category_id=fun,organized_by='owner' where id=t3;
  insert into public.transaction_split_sets(workspace_id,transaction_id,request_id,actor_id,before,after) values(workspace,t4,gen_random_uuid(),actor,'{}','{}');
  insert into public.correction_events(workspace_id,transaction_id,actor_id,before,after)
    values(workspace,t5,actor,jsonb_build_object('category_id',null,'version',0),jsonb_build_object('category_id',fun,'version',0));
  update public.transactions set category_id=fun,organized_by=null where id=t5;
  update public.transactions set kind='transfer' where id=t6;

  -- Spellings unify through any shared alias; a rerun changes nothing.
  result:=public.resolve_organize_identities(workspace,(select jsonb_agg(jsonb_build_object('transaction_id',id,'kind','merchant','display_name','Cafe Luna','aliases',cafe_aliases)) from unnest(array[t1,t2,t3,t4,t5,t6]) id)
    ||jsonb_build_array(jsonb_build_object('transaction_id',t7,'kind','merchant','display_name','CAFE LUNA','aliases','[{"type":"description_key","value":"cafe luna"}]'::jsonb),
      jsonb_build_object('transaction_id',t8,'kind','merchant','display_name','Cafe Luna GmbH','aliases','[{"type":"card_merchant","value":"cafe luna kiosk"},{"type":"description_key","value":"cafe luna"}]'::jsonb),
      jsonb_build_object('transaction_id',pay,'kind','processor','display_name','PayPal · Synthetic Music','aliases','[{"type":"description_key","value":"paypal:synthetic music"}]'::jsonb)));
  if result<>'{"resolved":9,"created":2}'::jsonb then raise exception 'Resolver made the wrong identities: %',result; end if;
  select identity_id into strict cafe from public.transactions where id=t1;
  select identity_id into strict processor from public.transactions where id=pay;
  if (select count(distinct identity_id) from public.transactions where id in (t1,t2,t3,t4,t5,t6,t7,t8))<>1 or processor=cafe
    or not exists(select 1 from public.organize_identity_aliases where identity_id=cafe and alias_type='card_merchant' and value='cafe luna kiosk')
    then raise exception 'Aliases did not unify one identity'; end if;
  result:=public.resolve_organize_identities(workspace,jsonb_build_array(jsonb_build_object('transaction_id',t1,'kind','person','display_name','Other','aliases','[{"type":"iban","value":"DE00000000000000000001"}]'::jsonb)));
  if result<>'{"resolved":0,"created":0}'::jsonb or (select identity_id from public.transactions where id=t1)<>cafe then raise exception 'Rerun changed a resolved row'; end if;

  perform set_config('request.jwt.claim.sub',stranger::text,true);
  begin
    perform public.confirm_organize_memory(cafe,null,null,true,'Coffee');
    raise exception 'Foreign memory accepted' using errcode='ZX001';
  exception when sqlstate 'P0002' then null; end;

  -- The owner confirms: blank and AI rows of that identity are labelled as one batch; owner, corrected, split and transfer rows are not.
  perform set_config('request.jwt.claim.sub',actor::text,true);
  result:=public.confirm_organize_memory(cafe,food,shop,true);
  if (result->>'applied')::integer<>4 then raise exception 'Memory applied to the wrong rows: %',result; end if;
  if exists(select 1 from public.transactions where id in (t1,t2,t7,t8) and (category_id<>food or merchant_id<>shop or organized_by<>'memory'))
    then raise exception 'Memory labels or provenance not written'; end if;
  if exists(select 1 from public.transactions where id in (t3,t5) and category_id is distinct from fun) or exists(select 1 from public.transactions where id in (t4,t6) and category_id is not null)
    then raise exception 'Memory touched a protected row'; end if;
  if not exists(select 1 from public.organize_memory where id=(result->>'memoryId')::uuid and source='owner' and confirmed_at is not null and category_id=food)
    then raise exception 'Memory not stored as the owner''s'; end if;
  -- An AI label never overrides it afterwards: the rows now carry an owner correction.
  if (public.apply_ai_organization(workspace,null,jsonb_build_array(jsonb_build_object('transaction_id',t1,'expected_version',(select version from public.transactions where id=t1),
    'category_id',fun,'confidence','high','identity_key','cafe luna')))->>'applied')<>'0' then raise exception 'AI overrode owner memory'; end if;

  -- The existing batch Undo restores every row exactly, AI provenance included.
  select jsonb_agg(jsonb_build_object('id',id,'version',version)) into rows from public.transactions where id in (t1,t2,t7,t8);
  perform public.undo_transaction_batch((result->>'batchId')::uuid,rows);
  select * into strict tx from public.transactions where id=t2;
  if tx.category_id<>fun or tx.merchant_id is not null or tx.organized_by<>'ai' or tx.ai_confidence<>'high' then raise exception 'Undo lost the AI labels'; end if;
  if exists(select 1 from public.transactions where id in (t1,t7,t8) and (category_id is not null or merchant_id is not null or organized_by is not null)) then raise exception 'Undo left memory labels'; end if;

  -- A processor's name alone never carries memory; with its description it does.
  insert into public.organize_identities(workspace_id,kind,display_name) values(workspace,'processor','PayPal') returning id into bare_processor;
  insert into public.organize_identity_aliases(workspace_id,identity_id,alias_type,value) values(workspace,bare_processor,'counterparty_name','paypal');
  begin
    perform public.confirm_organize_memory(bare_processor,fun,null,true);
    raise exception 'Processor-name memory accepted' using errcode='ZX001';
  exception when sqlstate '22023' then null; end;
  if (public.confirm_organize_memory(processor,fun,null,true)->>'applied')<>'1' or (select category_id from public.transactions where id=t1) is not null
    then raise exception 'Processor memory spread beyond its description'; end if;

  -- One question per identity: new rows join it while open; answered, it stays answered.
  execute 'reset role';
  asked:=public.raise_organize_question(workspace,'internal:to eur',null,'"To Eur" moves money with nobody else on the other side. What is it?',array[t1],'system');
  again:=public.raise_organize_question(workspace,'internal:to eur',cafe,'"To Eur" moves money with nobody else on the other side. What is it?',array[t7,t1],'system');
  if again<>asked or (select count(*) from public.organize_questions where workspace_id=workspace)<>1
    or (select transaction_ids from public.organize_questions where id=asked)<>(select array_agg(id order by id) from unnest(array[t1,t7]) id)
    then raise exception 'Question was not raised once per identity'; end if;
  perform set_config('request.jwt.claim.sub',stranger::text,true);
  begin
    perform public.answer_organize_question(asked,'dismissed');
    raise exception 'Foreign answer accepted' using errcode='ZX001';
  exception when sqlstate 'P0002' then null; end;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform public.answer_organize_question(asked,'answered','{"kind":"own_pocket"}');
  perform public.raise_organize_question(workspace,'internal:to eur',null,'Again?',array[t8],'system');
  if (select status||cardinality(transaction_ids) from public.organize_questions where id=asked)<>'answered2' then raise exception 'An answered question changed'; end if;

  -- An exchange: each leg a transfer in its own currency, naming the other, undone leg by leg.
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code) values
    (e1,workspace,account,'2026-10-02','Exchanged to USD',-10000,'EUR'),(e2,workspace,usd_account,'2026-10-02','Exchanged from EUR',10870,'USD');
  begin
    perform public.mark_own_exchange(e1,0,t1);
    raise exception 'Same-currency exchange side accepted' using errcode='ZX001';
  exception when sqlstate '22023' then null; end;
  perform public.mark_own_exchange(e1,0,e2);
  perform public.mark_own_exchange(e2,0,e1);
  if exists(select 1 from public.transactions where id in (e1,e2) and (kind<>'transfer' or transfer_id is not null or version<>1))
    or (select amount_minor from public.transactions where id=e2)<>10870 then raise exception 'Exchange legs not marked as observed'; end if;
  select id into strict event_id from public.correction_events where transaction_id=e1 and after->>'rule'='exchange' and after->>'exchange_with'=e2::text;
  perform public.undo_own_account_transfer(event_id,1);
  if (select kind from public.transactions where id=e1)<>'ordinary' or (select kind from public.transactions where id=e2)<>'transfer' then raise exception 'Exchange undo was not per leg'; end if;
end $$;
