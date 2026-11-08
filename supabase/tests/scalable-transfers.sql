-- Scalable's transfers are saved once by its own ID, keep earlier states, and only an active connection can write them.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; connection uuid:=gen_random_uuid(); row_one jsonb; saved public.scalable_transfers%rowtype;
begin
  insert into auth.users(id,email) values(actor,'qa-transfers-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.scalable_connections(id,workspace_id,client_id,redirect_uri,status,tokens_encrypted) values(connection,workspace,'client','http://localhost/callback','active','one');
  row_one:=jsonb_build_object('provider_id','W1','type','WITHDRAWAL','amount_minor','-40000','currency_code','EUR','occurred_at','2026-08-24T09:00:00Z','on_date','2026-08-24','status','PENDING','is_cancellation',false,'description','Withdrawal','returns_provider_id',null);
  if public.save_scalable_transfers(connection,jsonb_build_array(row_one,row_one||'{"provider_id":"RETURN-W1","type":"DEPOSIT","amount_minor":"40000","returns_provider_id":"W1"}'),false)<>2 then raise exception 'Expected two new transfers'; end if;
  if public.save_scalable_transfers(connection,jsonb_build_array(row_one),false)<>0 then raise exception 'The same transfer counted as new'; end if;
  if public.save_scalable_transfers(connection,jsonb_build_array(row_one||'{"status":"SETTLED"}'),true)<>1 then raise exception 'A revision was not saved'; end if;
  select * into strict saved from public.scalable_transfers where workspace_id=workspace and provider_id='W1';
  if saved.status<>'SETTLED' or saved.revision<>2 or saved.revisions->0->>'status'<>'PENDING' then raise exception 'The earlier state was lost'; end if;
  if (select returns_provider_id from public.scalable_transfers where workspace_id=workspace and provider_id='RETURN-W1')<>'W1' then raise exception 'The return lost its withdrawal'; end if;
  if (select transfers_backfilled_at from public.scalable_connections where id=connection) is null then raise exception 'A complete read was not remembered'; end if;
  if has_function_privilege('authenticated','public.save_scalable_transfers(uuid,jsonb,boolean)','execute') then raise exception 'Owners must not write broker records'; end if;
  update public.scalable_connections set status='revoked',tokens_encrypted=null where id=connection;
  begin perform public.save_scalable_transfers(connection,'[]',false); raise exception 'A disconnected connection wrote transfers' using errcode='ZX001'; exception when sqlstate 'P0002' then null; end;
  if not exists(select 1 from public.scalable_transfers where workspace_id=workspace) then raise exception 'Disconnecting must keep the records'; end if;
end;
$$;
