-- Synthetic users only. The migration runner executes this inside a rollback.
-- Calculated Scalable values: a run replaces a workspace's rows as one, keeps them if it fails, and only the service role writes.
do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_a uuid;
  workspace_b uuid;
  connection uuid := gen_random_uuid();
  total integer;
  good jsonb := '[{"on_date":"2026-01-01","currency_code":"EUR","securities_minor":"1","crypto_minor":"2","cash_minor":"3","total_minor":"6"},{"on_date":"2026-01-02","currency_code":"EUR","securities_minor":"1","crypto_minor":"2","cash_minor":"4","total_minor":"7"}]';
begin
  insert into auth.users(id,email) values(user_a,'qa-'||user_a||'@example.invalid'),(user_b,'qa-'||user_b||'@example.invalid');
  select id into strict workspace_a from public.workspaces where owner_id=user_a;
  select id into strict workspace_b from public.workspaces where owner_id=user_b;
  insert into public.scalable_connections(id,workspace_id,client_id,redirect_uri,status,tokens_encrypted) values(connection,workspace_a,'synthetic','http://localhost/callback','active','sealed');
  insert into public.scalable_value_history(workspace_id,on_date,currency_code,securities_minor,crypto_minor,cash_minor,total_minor) values
    (workspace_a,'2020-01-01','EUR',9,0,0,9),(workspace_b,'2020-01-01','EUR',8,0,0,8);

  if public.replace_scalable_value_history(connection,good,'2026-03-01')<>2 then raise exception 'Expected two saved days'; end if;
  if exists(select 1 from public.scalable_value_history where workspace_id=workspace_a and on_date='2020-01-01') then raise exception 'Old days must be replaced'; end if;
  if not exists(select 1 from public.scalable_value_history where workspace_id=workspace_b and on_date='2020-01-01') then raise exception 'Another workspace must be untouched'; end if;
  if not exists(select 1 from public.scalable_connections where id=connection and history_status='ok' and history_checked_on='2026-03-01' and history_error is null) then raise exception 'Status must be recorded'; end if;

  begin
    perform public.replace_scalable_value_history(connection,'[{"on_date":"2026-02-01","currency_code":"EUR","securities_minor":"1","crypto_minor":"2","cash_minor":"3","total_minor":"99"}]','2026-03-02');
    raise exception 'A wrong total was saved' using errcode='ZX001';
  exception when check_violation then null; end;
  select count(*) into total from public.scalable_value_history where workspace_id=workspace_a and on_date in ('2026-01-01','2026-01-02');
  if total<>2 then raise exception 'A failed run must keep the saved days'; end if;

  update public.scalable_connections set status='revoked',tokens_encrypted=null where id=connection;
  begin
    perform public.replace_scalable_value_history(connection,'[]','2026-03-02');
    raise exception 'A disconnected connection saved history' using errcode='ZX001';
  exception when no_data_found then null; end;
  update public.scalable_connections set status='active',tokens_encrypted='sealed' where id=connection;

  perform set_config('request.jwt.claim.sub', user_a::text, true);
  execute 'set local role authenticated';
  select count(*) into total from public.scalable_value_history;
  if total<>2 then raise exception 'The owner sees only their own days, saw %',total; end if;
  begin
    insert into public.scalable_value_history(workspace_id,on_date,currency_code,securities_minor,crypto_minor,cash_minor,total_minor) values(workspace_a,'2021-01-01','EUR',0,0,0,0);
    raise exception 'The owner wrote a calculated day' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.replace_scalable_value_history(connection,'[]','2026-03-03');
    raise exception 'The owner called the service function' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
end;
$$;
