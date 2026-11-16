-- Saved charts and trades replace by key, drop securities no longer held, are removable on disconnect, and only an active connection writes them.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; connection uuid:=gen_random_uuid(); chart jsonb; trade jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-charts-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.scalable_connections(id,workspace_id,client_id,redirect_uri,status,tokens_encrypted) values(connection,workspace,'client','http://localhost/callback','active','one');
  chart:=jsonb_build_object('isin','IE00B4L5Y983','timeframe','one_month','currency_code','EUR','points','[{"at":"2026-10-01T00:00:00Z","price":"1.5"}]'::jsonb,'fetched_at','2026-10-02T00:00:00Z');
  trade:=jsonb_build_object('provider_id','T1','isin','IE00B4L5Y983','side','BUY','occurred_at','2026-10-01T09:00:00Z','quantity_text','2');
  perform public.save_scalable_charts(connection,jsonb_build_array(chart,chart||'{"isin":"US0378331005"}'),jsonb_build_array(trade),array['IE00B4L5Y983','US0378331005']);
  perform public.save_scalable_charts(connection,jsonb_build_array(chart||'{"points":[{"at":"2026-10-03T00:00:00Z","price":"1.7"}]}'),jsonb_build_array(trade),array['IE00B4L5Y983']);
  if (select count(*) from public.scalable_security_charts where workspace_id=workspace)<>1 then raise exception 'A sold security kept its chart or a chart was duplicated'; end if;
  if (select points->0->>'price' from public.scalable_security_charts where workspace_id=workspace)<>'1.7' then raise exception 'A new sync did not replace the chart'; end if;
  if (select count(*) from public.scalable_security_trades where workspace_id=workspace)<>1 then raise exception 'A repeated trade was saved twice'; end if;
  perform public.save_scalable_charts(connection,'[]',jsonb_build_array(trade||'{"provider_id":"T2","side":"SELL"}'),null);
  if (select count(*) from public.scalable_security_charts where workspace_id=workspace)<>1 then raise exception 'Saving trades alone must keep the charts'; end if;
  if has_function_privilege('authenticated','public.save_scalable_charts(uuid,jsonb,jsonb,text[])','execute') then raise exception 'Owners must not write broker records'; end if;
  perform public.remove_scalable_charts(workspace);
  if exists(select 1 from public.scalable_security_charts where workspace_id=workspace) or exists(select 1 from public.scalable_security_trades where workspace_id=workspace) then raise exception 'A disconnect left chart data behind'; end if;
  update public.scalable_connections set status='revoked',tokens_encrypted=null where id=connection;
  begin perform public.save_scalable_charts(connection,jsonb_build_array(chart),'[]',null); raise exception 'A disconnected connection wrote charts' using errcode='ZX001'; exception when sqlstate 'P0002' then null; end;
end;
$$;
