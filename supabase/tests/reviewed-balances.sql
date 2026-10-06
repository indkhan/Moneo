do $$
declare actor uuid:=gen_random_uuid(); foreign_actor uuid:=gen_random_uuid(); workspace uuid; foreign_workspace uuid;
  account uuid; foreign_account uuid; goal uuid; baseline uuid; morning uuid; date_only uuid; later uuid; unknown_row uuid;
  request uuid:=gen_random_uuid(); changed_request uuid:=gen_random_uuid(); receipt jsonb; result jsonb; reservation jsonb; evidence jsonb;
  snapshot public.balance_snapshots%rowtype; today date:=(clock_timestamp() at time zone 'Europe/Berlin')::date;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(foreign_actor,'qa-'||foreign_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict foreign_workspace from public.workspaces where owner_id=foreign_actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(workspace_id,name,currency_code) values(workspace,'Synthetic reviewed cash','EUR') returning id into account;
  insert into public.accounts(workspace_id,name,currency_code) values(foreign_workspace,'Synthetic foreign cash','EUR') returning id into foreign_account;
  insert into public.goals(workspace_id,name,target_minor,currency_code) values(workspace,'Synthetic reservation',20000,'EUR') returning id into goal;
  insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance)
    values(workspace,account,10000,'EUR',clock_timestamp()-interval '2 minutes','synthetic') returning id into baseline;
  insert into public.transactions(workspace_id,account_id,posted_on,posted_at,description,amount_minor,currency_code,status)
    values(workspace,account,today,clock_timestamp()-interval '1 minute','Synthetic timestamped posting',-100,'EUR','posted') returning id into morning;
  insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status)
    values(workspace,account,today,'Synthetic date-only posting',-200,'EUR','posted') returning id into date_only;
  insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status)
    values(workspace,account,today,'Synthetic pending hold',-1000,'EUR','pending');
  if public.reservation_balance_evidence(account,clock_timestamp(),'Europe/Berlin')->>'status'<>'ambiguous' then raise exception 'Unconfirmed same-day boundary became usable'; end if;
  select jsonb_agg(public.balance_review_record(t) order by t.id) into receipt from public.transactions t where t.id in(morning,date_only);
  execute 'set local role authenticated';
  begin perform public.record_manual_balance(foreign_account,'10000',today,true,'[]',null,0,gen_random_uuid()); raise exception 'Foreign balance accepted' using errcode='ZX001'; exception when sqlstate 'P0002' then null; end;
  begin insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance) values(workspace,account,1,'EUR',now(),'forged'); raise exception 'Direct snapshot forge allowed' using errcode='ZX001'; exception when insufficient_privilege then null; end;
  begin update public.balance_snapshots set amount_minor=1 where id=baseline; raise exception 'Direct snapshot edit allowed' using errcode='ZX001'; exception when insufficient_privilege then null; end;
  begin delete from public.balance_snapshots where id=baseline; raise exception 'Direct snapshot delete allowed' using errcode='ZX001'; exception when insufficient_privilege then null; end;
  begin perform public.record_manual_balance(account,'10000',today,true,'[]',baseline,1,gen_random_uuid()); raise exception 'Incomplete preview accepted' using errcode='ZX001'; exception when sqlstate '40001' then null; end;
  result:=public.record_manual_balance(account,'10000',today,true,receipt,baseline,1,request);
  if public.record_manual_balance(account,'10000',today,true,receipt,baseline,1,request)<>result then raise exception 'Retry duplicated history'; end if;
  begin perform public.record_manual_balance(account,'10001',today,true,receipt,baseline,1,request); raise exception 'Request reused with changed amount' using errcode='ZX001'; exception when sqlstate '22023' then null; end;
  begin perform public.record_manual_balance(account,'10000',today,true,receipt,baseline,1,gen_random_uuid()); raise exception 'Stale history receipt accepted' using errcode='ZX001'; exception when sqlstate '40001' then null; end;
  begin perform public.reserve_goal_funds(goal,account,'9001',0,gen_random_uuid()); raise exception 'Pending hold overreserved' using errcode='ZX001'; exception when sqlstate '22003' then null; end;
  reservation:=public.reserve_goal_funds(goal,account,'9000',0,gen_random_uuid());
  perform public.undo_goal_reservation((reservation->>'eventId')::uuid,1);
  execute 'reset role';
  select * into strict snapshot from public.balance_snapshots where id=request;
  evidence:=public.reservation_balance_evidence(account,snapshot.as_of+interval '1 second','Europe/Berlin');
  if evidence->>'amount_minor'<>'10000' or evidence->>'pending_hold_minor'<>'1000' then raise exception 'Covered postings double counted or hold omitted'; end if;
  -- A later timestamped posting must count exactly once. Date-only new same-day evidence cannot establish ordering.
  insert into public.transactions(workspace_id,account_id,posted_on,posted_at,description,amount_minor,currency_code,status)
    values(workspace,account,today,snapshot.as_of+interval '1 minute','Synthetic later posting',-250,'EUR','posted') returning id into later;
  if public.reservation_balance_evidence(account,snapshot.as_of+interval '2 minutes','Europe/Berlin')->>'amount_minor'<>'9750' then raise exception 'Later posting not counted once'; end if;
  insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status)
    values(workspace,account,today,'Synthetic unknown coverage',-1,'EUR','posted') returning id into unknown_row;
  if public.reservation_balance_evidence(account,snapshot.as_of+interval '2 minutes','Europe/Berlin')->>'status'<>'ambiguous' then raise exception 'New date-only row guessed'; end if;
  delete from public.transactions where id=unknown_row;
  update public.transactions set amount_minor=-101,version=version+1 where id=morning;
  if public.reservation_balance_evidence(account,snapshot.as_of+interval '2 minutes','Europe/Berlin')->>'status'<>'ambiguous' then raise exception 'Covered correction silently reused'; end if;
  execute 'set local role authenticated';
  begin perform public.record_manual_balance(account,'10000',today,true,receipt,request,1,changed_request); raise exception 'Changed preview accepted' using errcode='ZX001'; exception when sqlstate '40001' then null; end;
  perform public.undo_manual_balance(request,1,request,1);
  if public.undo_manual_balance(request,1,request,1)->>'undone'<>'true' then raise exception 'Undo retry failed'; end if;
  execute 'reset role';
  if not exists(select 1 from public.balance_snapshots where id=request and actor_id=actor and undone_by=actor and version=2 and covered_transactions=receipt and undone_at is not null)
    or not exists(select 1 from public.balance_snapshots where id=baseline) then raise exception 'Undo destroyed history/evidence'; end if;
  if public.reservation_balance_evidence(account,clock_timestamp(),'Europe/Berlin')->>'status'<>'ambiguous' then raise exception 'Undo did not restore previous uncertainty'; end if;
  -- Replay retains the undone result; old receipt version cannot be used to write after undo.
  execute 'set local role authenticated';
  if public.record_manual_balance(account,'10000',today,true,receipt,baseline,1,request)->>'undone'<>'true' then raise exception 'Retry resurrected undone balance'; end if;
  begin perform public.record_manual_balance(account,'10000',today,false,null,request,1,gen_random_uuid()); raise exception 'Pre-undo history version accepted' using errcode='ZX001'; exception when sqlstate '40001' then null; end;
  perform set_config('request.jwt.claim.sub',foreign_actor::text,true);
  begin perform public.undo_manual_balance(request,2,request,2); raise exception 'Foreign undo accepted' using errcode='ZX001'; exception when sqlstate 'P0002' then null; end;
  perform set_config('request.jwt.claim.sub','',true);
  begin perform public.record_manual_balance(account,'1',today,false,null,request,2,gen_random_uuid()); raise exception 'Unauthenticated command accepted' using errcode='ZX001'; exception when sqlstate '28000' then null; end;
  execute 'reset role';
  -- Local historical dates are interpreted in workspace timezone by the command.
  insert into public.workspace_settings(workspace_id,timezone) values(workspace,'America/Los_Angeles')
    on conflict(workspace_id) do update set timezone='America/Los_Angeles';
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  result:=public.record_manual_balance(account,'10000',today-2,false,null,request,2,gen_random_uuid());
  execute 'reset role';
  if not exists(select 1 from public.balance_snapshots where id=(result->>'snapshotId')::uuid and
    as_of=((today-2)::timestamp at time zone 'America/Los_Angeles') and boundary_kind='date_only') then raise exception 'Historical local date changed'; end if;
end;
$$;
