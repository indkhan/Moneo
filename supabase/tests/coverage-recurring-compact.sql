-- R1 compact receipt boundary; no browser/client financial fields are trusted.
do $$
declare actor uuid:=gen_random_uuid(); foreign_actor uuid:=gen_random_uuid(); w uuid; foreign_w uuid; account uuid:=gen_random_uuid(); foreign_account uuid:=gen_random_uuid(); merchant uuid:=gen_random_uuid(); ids uuid[]:=array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; alien uuid:=gen_random_uuid(); versions jsonb; stale jsonb; series public.recurring_series%rowtype; originals jsonb; i integer;
begin
 insert into auth.users(id,email) values(actor,'mne014-r1-compact-'||actor||'@example.invalid'),(foreign_actor,'mne014-r1-foreign-'||foreign_actor||'@example.invalid');
 select id into strict w from public.workspaces where owner_id=actor;
 select id into strict foreign_w from public.workspaces where owner_id=foreign_actor;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 insert into public.accounts(id,workspace_id,name,currency_code) values(account,w,'Compact sources','EUR'),(foreign_account,foreign_w,'Other owner','EUR');
 insert into public.merchants(id,workspace_id,name,normalized_name) values(merchant,w,'Compact stable merchant','compact stable merchant');
 for i in 1..3 loop
   insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind,merchant_id)
   values(ids[i],w,account,('2025-10-31'::date+make_interval(months=>3*(i-1)))::date,repeat(chr(8364),490)||' invoice '||i,-9007199254740993,'EUR','posted','ordinary',merchant);
 end loop;
 insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind)
 values(alien,foreign_w,foreign_account,'2026-04-30','Foreign compact source',-9007199254740993,'EUR','posted','ordinary');
 select jsonb_agg(to_jsonb(t) order by id),jsonb_agg(jsonb_build_object('id',id,'version',version) order by posted_on,id) into originals,versions from public.transactions t where id=any(ids);
 execute 'set local role authenticated';
 stale:=jsonb_set(versions,'{0,version}','1'::jsonb);
 begin
   perform public.review_recurring_series_versions('confirmed',account,'Short merchant label','quarterly','EUR',stale,ids[1]);
   raise exception 'Compact stale versions accepted';
 exception when sqlstate '40001' then null; end;
 begin
   perform public.review_recurring_series_versions('confirmed',account,'Short merchant label','quarterly','EUR',jsonb_set(versions,'{2,id}',to_jsonb(alien::text)),ids[1]);
   raise exception 'Compact foreign source accepted';
 exception when sqlstate 'P0002' then null; end;
 series:=public.review_recurring_series_versions('confirmed',account,'Short merchant label','quarterly','EUR',versions,ids[1]);
 if series.status<>'confirmed' or series.amount_min_minor<>-9007199254740993 then raise exception 'Compact confirmation lost exact money'; end if;
 series:=public.review_recurring_series_versions('dismissed',account,'Short merchant label','quarterly','EUR',versions,ids[1]);
 if series.status<>'dismissed' then raise exception 'Compact decline failed'; end if;
 execute 'reset role';
 if originals is distinct from (select jsonb_agg(to_jsonb(t) order by id) from public.transactions t where id=any(ids)) then raise exception 'Compact decision rewrote ledger sources'; end if;
 -- The compact boundary must still reach eligibility checks, not only versions.
 update public.transactions set kind='transfer',version=version+1 where id=ids[3];
 select jsonb_agg(jsonb_build_object('id',id,'version',version) order by posted_on,id) into versions from public.transactions where id=any(ids);
 execute 'set local role authenticated';
 begin
   perform public.review_recurring_series_versions('confirmed',account,'Short merchant label','quarterly','EUR',versions,ids[1]);
   raise exception 'Compact classified transfer source accepted';
 exception when sqlstate '22023' then null; end;
 execute 'reset role';
end;
$$;

-- The actual compact RPC must support its complete 1000-source ceiling too.
do $$
declare actor uuid:=gen_random_uuid(); w uuid; account uuid:=gen_random_uuid(); merchant uuid:=gen_random_uuid(); versions jsonb; anchor uuid; series public.recurring_series%rowtype; original_count integer; original_total numeric;
begin
 insert into auth.users(id,email) values(actor,'mne014-r1-large-'||actor||'@example.invalid');
 select id into strict w from public.workspaces where owner_id=actor;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 insert into public.accounts(id,workspace_id,name,currency_code) values(account,w,'Compact maximum history','EUR');
 insert into public.merchants(id,workspace_id,name,normalized_name) values(merchant,w,'Maximum stable merchant','maximum stable merchant');
 insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind,merchant_id)
 select w,account,'2000-01-03'::date+7*n,repeat(chr(8364),490)||' invoice '||n,-9007199254740993,'EUR','posted','ordinary',merchant from generate_series(0,999) n;
 select jsonb_agg(jsonb_build_object('id',id,'version',version) order by posted_on,id),count(*),sum(amount_minor::numeric) into versions,original_count,original_total from public.transactions where account_id=account and workspace_id=w;
 anchor:=(versions->0->>'id')::uuid;
 execute 'set local role authenticated';
 series:=public.review_recurring_series_versions('confirmed',account,'Short maximum label','weekly','EUR',versions,anchor);
 if series.occurrences<>1000 or series.amount_min_minor<>-9007199254740993 then raise exception 'Compact maximum evidence lost count or exact amount'; end if;
 series:=public.review_recurring_series_versions('dismissed',account,'Short maximum label','weekly','EUR',versions,anchor);
 execute 'reset role';
 if (select count(*) from public.recurring_series_transactions where series_id=series.id)<>1000 or original_count<>1000 or original_total<>-9007199254740993000 then raise exception 'Compact maximum original evidence lost'; end if;
 if (select sum(amount_minor::numeric) from public.transactions where account_id=account and workspace_id=w) is distinct from original_total then raise exception 'Maximum decision changed original money'; end if;
end;
$$;
