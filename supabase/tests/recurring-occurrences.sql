do $$
declare actor uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); w uuid; foreign_w uuid; account uuid:=gen_random_uuid(); foreign_account uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); t uuid:=gen_random_uuid(); foreign_t uuid:=gen_random_uuid(); r public.recurring_occurrence_settlements%rowtype; saved_receipt jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-occurrence-'||actor||'@example.invalid'),(other,'qa-occurrence-'||other||'@example.invalid');
  select id into strict w from public.workspaces where owner_id=actor;
  select id into strict foreign_w from public.workspaces where owner_id=other;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,w,'Occurrence cash','EUR'),(foreign_account,foreign_w,'Other cash','EUR');
  insert into public.financial_assumptions(id,workspace_id,account_id,kind,name,amount_minor,currency_code,cadence,starts_on,source,confirmed,enabled)
    values(a,w,account,'expense','Explicit rent',-10000,'EUR','monthly','2026-01-31','user',true,true);
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind)
    values(t,w,account,'2026-02-25','Partial rent',-4000,'EUR','pending','ordinary'),(foreign_t,foreign_w,foreign_account,'2026-02-25','Foreign',-4000,'EUR','posted','ordinary');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  begin
    perform public.record_recurring_occurrence(a,0,'2026-02-28',t,0,false);
    raise exception 'Stale assumption accepted';
  exception when sqlstate '40001' then null; end;
  begin
    perform public.record_recurring_occurrence(a,1,'2026-02-27',t,0,false);
    raise exception 'Nonoccurrence date accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.record_recurring_occurrence(a,1,'2026-02-28',foreign_t,0,false);
    raise exception 'Foreign transaction accepted';
  exception when sqlstate 'P0002' then null; end;
  r:=public.record_recurring_occurrence(a,1,'2026-02-28',t,0,false);
  saved_receipt:=r.receipt;
  if r.scheduled_on<>'2026-02-28' or r.completes_occurrence or r.actor_id<>actor or saved_receipt->>'amount_minor'<>'-4000' then raise exception 'Receipt not exact'; end if;
  begin
    perform public.record_recurring_occurrence(a,1,'2026-03-31',t,0,true);
    raise exception 'One posting assigned twice';
  exception when unique_violation then null; end;
  update public.transactions set status='posted',posted_on='2026-03-02',version=version+1 where id=t;
  if (select s.receipt from public.recurring_occurrence_settlements s where s.id=r.id)<>saved_receipt then raise exception 'Settlement transition rewrote receipt'; end if;
  perform set_config('request.jwt.claim.sub',other::text,true);
  begin
    perform public.undo_recurring_occurrence(r.id,1);
    raise exception 'Foreign undo accepted';
  exception when sqlstate 'P0002' then null; end;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  begin
    perform public.undo_recurring_occurrence(r.id,0);
    raise exception 'Stale undo accepted';
  exception when sqlstate '40001' then null; end;
  r:=public.undo_recurring_occurrence(r.id,1);
  if r.undone_at is null or r.version<>2 or r.receipt<>saved_receipt then raise exception 'Undo destroyed history'; end if;
  update public.transactions set amount_minor=-12000,version=version+1 where id=t;
  r:=public.record_recurring_occurrence(a,1,'2026-02-28',t,2,true);
  if r.receipt->>'amount_minor'<>'-12000' or not r.completes_occurrence then raise exception 'Changed amount review failed'; end if;
  if (select count(*) from public.recurring_occurrence_settlements where transaction_id=t)<>2 then raise exception 'Reassociation destroyed immutable previous receipt'; end if;
  delete from public.transactions where id=t;
  if (select count(*) from public.recurring_occurrence_settlements where transaction_id=t)<>2 then raise exception 'Canonical deletion destroyed receipt history'; end if;
  perform set_config('request.jwt.claim.sub',other::text,true);
  execute 'set local role authenticated';
  if exists(select 1 from public.recurring_occurrence_settlements where workspace_id=w) then raise exception 'Foreign settlement visible'; end if;
  execute 'reset role';
end;
$$;


