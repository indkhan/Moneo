-- Synthetic pending lifecycle. All rows/schema roll back in the runner.
do $$
declare actor uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid(); workspace uuid; foreign_workspace uuid; account uuid:=gen_random_uuid(); foreign_account uuid:=gen_random_uuid();
  pending uuid:=gen_random_uuid(); posted uuid:=gen_random_uuid(); partial uuid:=gen_random_uuid(); foreign_posted uuid:=gen_random_uuid();
  request uuid:=gen_random_uuid(); resolution uuid; original_pending jsonb; original_posted jsonb; result jsonb; today date:=(now() at time zone 'Europe/Berlin')::date;
begin
  insert into auth.users(id,email) values(actor,'pending-'||actor||'@example.invalid'),(other_actor,'pending-'||other_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict foreign_workspace from public.workspaces where owner_id=other_actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Synthetic pending','EUR'),(foreign_account,foreign_workspace,'Foreign','EUR');
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status) values
    (pending,workspace,account,today-2,'Original hold',-2000,'EUR','pending'),
    (posted,workspace,account,today-1,'Changed date and amount',-1800,'EUR','posted'),
    (partial,workspace,account,today-1,'Partial capture',-500,'EUR','posted'),
    (foreign_posted,foreign_workspace,foreign_account,today-1,'Foreign',-2000,'EUR','posted');
  perform set_config('moneo.balance_review','on',true);
  insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,covered_transactions,actor_id)
    values(workspace,account,8000,'EUR',now()-interval '1 minute','manual','reviewed_activity','[]',actor);
  perform set_config('moneo.balance_review','off',true);
  select public.link_money_snapshot(t) into original_pending from public.transactions t where id=pending;
  select public.link_money_snapshot(t) into original_posted from public.transactions t where id=posted;
  if public.reservation_balance_evidence(account,now(),'Europe/Berlin')->>'pending_hold_minor'<>'2000' then raise exception 'Baseline hold incorrect'; end if;
  execute 'set local role authenticated';
  begin
    perform public.resolve_pending_hold(pending,0,0,foreign_posted,0,2000,'Cannot use foreign evidence',gen_random_uuid());
    raise exception 'Foreign settlement accepted' using errcode='ZX001';
  exception when no_data_found then null; end;
  begin
    insert into public.pending_hold_resolutions(workspace_id,pending_transaction_id,operation,released_minor,request_id,input,receipt,note,actor_id)
      values(workspace,pending,'cancel',2000,gen_random_uuid(),'{}','{}','Bypass',actor);
    raise exception 'Untrusted lifecycle insert' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  result:=public.resolve_pending_hold(pending,0,0,partial,0,500,'Reviewed partial capture; remaining hold still outstanding',request);
  resolution:=(result->>'resolutionId')::uuid;
  if public.resolve_pending_hold(pending,0,0,partial,0,500,'Reviewed partial capture; remaining hold still outstanding',request) is distinct from result then raise exception 'Retry not idempotent'; end if;
  begin
    perform public.resolve_pending_hold(pending,0,0,posted,0,1500,'Stale lifecycle snapshot',gen_random_uuid());
    raise exception 'Stale pending release accepted' using errcode='ZX001';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.resolve_pending_hold(pending,0,500,partial,0,500,'Duplicate capture',gen_random_uuid());
    raise exception 'Settlement reused' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.resolve_pending_hold(pending,0,500,posted,0,1501,'Over release',gen_random_uuid());
    raise exception 'Over release accepted' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  execute 'reset role';
  if public.reservation_balance_evidence(account,now(),'Europe/Berlin')->>'pending_hold_minor'<>'1500' then raise exception 'Partial hold not retained'; end if;
  begin
    update public.transactions set amount_minor=-1 where id=pending;
    raise exception 'Retired financial evidence editable' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    delete from public.transactions where id=partial;
    raise exception 'Active settlement deleted' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  execute 'set local role authenticated';
  perform public.undo_pending_hold_resolution(resolution);
  perform public.undo_pending_hold_resolution(resolution);
  execute 'reset role';
  if public.reservation_balance_evidence(account,now(),'Europe/Berlin')->>'pending_hold_minor'<>'2000' then raise exception 'Undo did not restore hold'; end if;
  execute 'set local role authenticated';
  result:=public.resolve_pending_hold(pending,0,0,posted,0,2000,'Final smaller capture releases the full authorization',gen_random_uuid());
  execute 'reset role';
  if public.reservation_balance_evidence(account,now(),'Europe/Berlin')->>'pending_hold_minor'<>'0' then raise exception 'Full capture leaves obsolete hold'; end if;
  update public.accounts set archived_at=now() where id=account;
  execute 'set local role authenticated';
  begin
    perform public.undo_pending_hold_resolution((result->>'resolutionId')::uuid);
    raise exception 'Restored hold in archived account' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  execute 'reset role';
  update public.accounts set archived_at=null where id=account;
  if (select public.link_money_snapshot(t) from public.transactions t where id=pending) is distinct from original_pending
    or (select public.link_money_snapshot(t) from public.transactions t where id=posted) is distinct from original_posted then raise exception 'Original financial evidence changed'; end if;
  perform set_config('request.jwt.claim.sub',other_actor::text,true);
  execute 'set local role authenticated';
  if exists(select 1 from public.pending_hold_resolutions where workspace_id=workspace) then raise exception 'Foreign resolution visible'; end if;
  begin
    perform public.undo_pending_hold_resolution((result->>'resolutionId')::uuid);
    raise exception 'Foreign undo accepted' using errcode='ZX001';
  exception when no_data_found then null; end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  perform public.undo_pending_hold_resolution((result->>'resolutionId')::uuid);
  result:=public.resolve_pending_hold(pending,0,0,null,null,2000,'Bank confirmed cancellation of the authorization',gen_random_uuid());
  execute 'reset role';
  if public.reservation_balance_evidence(account,now(),'Europe/Berlin')->>'pending_hold_minor'<>'0' then raise exception 'Cancellation leaves hold'; end if;
  execute 'set local role authenticated';
  perform public.undo_pending_hold_resolution((result->>'resolutionId')::uuid);
  execute 'reset role';
  if public.reservation_balance_evidence(account,now(),'Europe/Berlin')->>'pending_hold_minor'<>'2000' then raise exception 'Cancellation undo failed'; end if;
end;
$$;

-- Same-reference status change remains reviewable; explicit acceptance retires atomically.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); source_route uuid:=gen_random_uuid();
  pending_import uuid:=gen_random_uuid(); posted_import uuid:=gen_random_uuid(); pending_source uuid:=gen_random_uuid(); posted_source uuid:=gen_random_uuid();
  pending_id uuid; posted_id uuid; request uuid:=gen_random_uuid(); payload jsonb; pending_original jsonb:='{"Date":"2026-10-01","Amount":"-20","Reference":"bank-1","State":"pending"}';
  posted_original jsonb:='{"Date":"2026-10-03","Amount":"-18","Reference":"bank-1","State":"posted"}'; resolution uuid; preview jsonb;
begin
  insert into auth.users(id,email) values(actor,'pending-import-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  pending_id:=public.stable_import_uuid(pending_import::text||':transaction:2');
  posted_id:=public.stable_import_uuid(posted_import::text||':transaction:2');
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values
    (pending_import,workspace,'synthetic-pending.csv',workspace||'/pending.csv',pending_import::text,'queued',1,'{}'),
    (posted_import,workspace,'synthetic-posted.csv',workspace||'/posted.csv',posted_import::text,'queued',1,'{}');
  execute 'set local role service_role';
  perform public.prepare_import_route(pending_import,workspace,1,account,source_route,'Synthetic','EUR',1);
  perform public.prepare_import_route(posted_import,workspace,1,account,source_route,'Synthetic','EUR',1);
  payload:=jsonb_build_object('accountName','Synthetic','sourceId',pending_source,'transactionId',pending_id,'rowNumber',2,'originalRow',pending_original,
    'externalId','bank-1','reviewReasons','[]'::jsonb,'postedOn','2026-10-01','description','Original payment','amountMinor','-2000','currencyCode','EUR','status','pending','kind','ordinary','action','new','reportProgress',true);
  perform public.ingest_import_row(pending_import,workspace,1,account,payload);
  perform public.finish_import_run(pending_import,workspace,1,null);
  payload:=payload||jsonb_build_object('sourceId',posted_source,'transactionId',null,'originalRow',posted_original,'postedOn','2026-10-03','description','Posted payment','amountMinor','-1800','status','posted','action','review');
  perform public.ingest_import_row(posted_import,workspace,1,account,payload);
  perform public.finish_import_run(posted_import,workspace,1,null);
  execute 'reset role';
  execute 'set local role authenticated';
  begin
    perform public.settle_import_review(posted_source,pending_id,0,0,2001,'Invalid excessive release',gen_random_uuid());
    raise exception 'Invalid settlement accepted' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  execute 'reset role';
  if exists(select 1 from public.transactions where id=posted_id) or (select status from public.source_transactions where id=posted_source)<>'review' then raise exception 'Failed settlement leaked accepted posting'; end if;
  execute 'set local role authenticated';
  perform public.settle_import_review(posted_source,pending_id,0,0,2000,'Reviewed bank-1 final capture',request);
  execute 'reset role';
  update public.transactions set note='Harmless metadata edit',version=version+1 where id=posted_id;
  execute 'set local role authenticated';
  perform public.settle_import_review(posted_source,pending_id,0,0,2000,'Reviewed bank-1 final capture',request);
  execute 'reset role';
  if (select count(*) from public.transactions where workspace_id=workspace)<>2
    or (select count(*) from public.pending_hold_resolutions where workspace_id=workspace)<>1
    or (select original_row from public.source_transactions where id=pending_source)<>pending_original
    or (select original_row from public.source_transactions where id=posted_source)<>posted_original
    or (select amount_minor from public.transactions where id=pending_id)<>-2000
    or (select amount_minor from public.transactions where id=posted_id)<>-1800 then raise exception 'Source preservation or settlement idempotency failed'; end if;
  execute 'set local role authenticated';
  preview:=public.preview_import_undo(posted_import);
  if (preview->>'safe')::boolean then raise exception 'Import undo ignores active settlement history'; end if;
  begin
    perform public.undo_import(posted_import,1,0);
    raise exception 'Active settlement import removed' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  execute 'reset role';
  select id into strict resolution from public.pending_hold_resolutions where workspace_id=workspace;
  execute 'set local role authenticated';
  perform public.undo_pending_hold_resolution(resolution);
  perform public.undo_import(posted_import,1,0);
  execute 'reset role';
  if not exists(select 1 from public.transactions where id=pending_id and status='pending') or exists(select 1 from public.transactions where id=posted_id)
    or not exists(select 1 from public.source_transactions where id=posted_source and status='undone' and original_row=posted_original)
    or not exists(select 1 from public.pending_hold_resolutions where id=resolution and undone_at is not null and receipt->'posted'->>'id'=posted_id::text)
    then raise exception 'Settlement undo/import undo lost original sources or history'; end if;
end;
$$;
