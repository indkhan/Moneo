-- The analysis agents skip a pass whose fingerprint matches the last analysis, so every kind of change must move it.
do $$
declare actor uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); workspace uuid; elsewhere uuid; account uuid:=gen_random_uuid(); far uuid:=gen_random_uuid();
  row_id uuid:=gen_random_uuid(); before text; after text;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(other,'qa-'||other||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict elsewhere from public.workspaces where owner_id=other;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Fingerprint','EUR'),(far,elsewhere,'Elsewhere','EUR');
  before := public.agent_data_fingerprint(workspace);
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(row_id,workspace,account,'2026-10-01','CAFE',-450,'EUR');
  after := public.agent_data_fingerprint(workspace);
  if after = before then raise exception 'A new row did not change the fingerprint'; end if;
  before := after;
  update public.transactions set note='lunch', version=version+1 where id=row_id;
  if public.agent_data_fingerprint(workspace) = before then raise exception 'A changed row did not change the fingerprint'; end if;
  before := public.agent_data_fingerprint(workspace);
  insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(elsewhere,far,'2026-10-01','OTHER',-100,'EUR');
  if public.agent_data_fingerprint(workspace) <> before then raise exception 'Another workspace changed this fingerprint'; end if;
  if has_function_privilege('authenticated','public.agent_data_fingerprint(uuid)','execute') then raise exception 'Owners must not read fingerprints directly'; end if;
end;
$$;
