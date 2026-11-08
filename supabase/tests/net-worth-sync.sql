-- Bank balance observations and Scalable sync coordination.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; bank uuid:=gen_random_uuid(); scalable uuid:=gen_random_uuid(); account uuid; result integer; claimed boolean; before_version integer; item uuid:=gen_random_uuid(); debt uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.bank_connections(id,workspace_id,aspsp_name,aspsp_country,status,session_id_encrypted,valid_until) values(bank,workspace,'Test Bank','DE','active','sealed',now()+interval '30 days');

  -- A balance lands even for an account no import has created yet, and repeats aren't saved twice.
  perform public.record_bank_balance(bank,'Test Bank ••1','EUR',12345,'2026-10-01T22:00:00Z','CLBD');
  select id into strict account from public.accounts where workspace_id=workspace and name='Test Bank ••1';
  perform public.record_bank_balance(bank,'Test Bank ••1','EUR',12345,'2026-10-01T22:00:00Z','CLBD');
  if (select count(*) from public.balance_snapshots where account_id=account)<>1 then raise exception 'Repeated bank balance saved twice'; end if;
  if not exists(select 1 from public.balance_snapshots where account_id=account and balance_type='CLBD' and boundary_kind='date_only' and provenance='bank:CLBD' and amount_minor=12345 and actor_id is null) then raise exception 'Bank balance saved wrongly'; end if;
  perform public.record_bank_balance(bank,'Test Bank ••1','EUR',12000,'2026-10-02T09:00:00Z','ITBD');
  if (select count(*) from public.balance_snapshots where account_id=account)<>2 then raise exception 'A new bank balance was not saved'; end if;
  if has_function_privilege('authenticated','public.record_bank_balance(uuid,text,text,bigint,timestamp with time zone,text)','execute') then raise exception 'Owners must not write bank observations directly'; end if;

  insert into public.scalable_connections(id,workspace_id,client_id,redirect_uri,status,tokens_encrypted) values(scalable,workspace,'client','http://localhost/callback','active','one');
  -- Only one request at a time may spend the refresh token, and saving tokens moves the version and ends the claim.
  select token_version into strict before_version from public.scalable_connections where id=scalable;
  claimed:=public.claim_scalable_refresh(scalable,before_version);
  if not claimed then raise exception 'Free claim refused'; end if;
  if public.claim_scalable_refresh(scalable,before_version) then raise exception 'A second claim was granted'; end if;
  update public.scalable_connections set tokens_encrypted='two' where id=scalable;
  if (select token_version from public.scalable_connections where id=scalable)<>before_version+1 then raise exception 'Saving tokens did not move the version'; end if;
  if (select refresh_claimed_until from public.scalable_connections where id=scalable) is not null then raise exception 'Saving tokens did not end the claim'; end if;
  if public.claim_scalable_refresh(scalable,before_version) then raise exception 'A claim on replaced tokens was granted'; end if;

  -- A newer read wins whichever finishes first; negative cash is kept as a debt.
  result:=public.sync_scalable_wealth(scalable,jsonb_build_array(jsonb_build_object('id',item,'kind','asset','name','Scalable cash','currency_code','EUR','amount_minor','0','quantity_text',null,'unit_price_text',null,'cost_basis_minor',null,'as_of','2026-10-02'),
    jsonb_build_object('id',debt,'kind','debt','name','Scalable cash owed','currency_code','EUR','amount_minor','-500','quantity_text',null,'unit_price_text',null,'cost_basis_minor',null,'as_of','2026-10-02','annual_rate_text','0','monthly_payment_minor','0')),'{"totalMinor":"-500"}','2026-10-02T12:00:00Z');
  if result<>2 then raise exception 'Sync wrote % records', result; end if;
  if not exists(select 1 from public.wealth_items where id=debt and kind='debt' and amount_minor=-500) then raise exception 'Negative cash was not kept'; end if;
  result:=public.sync_scalable_wealth(scalable,'[]','{"totalMinor":"1"}','2026-10-02T11:00:00Z');
  if result<>-1 then raise exception 'An older read was accepted'; end if;
  if (select portfolio->>'totalMinor' from public.scalable_connections where id=scalable)<>'-500' then raise exception 'An older read overwrote a newer one'; end if;
  if exists(select 1 from public.wealth_items where id=debt and removed_at is not null) then raise exception 'An older read removed a position'; end if;
  result:=public.sync_scalable_wealth(scalable,jsonb_build_array(jsonb_build_object('id',item,'kind','asset','name','Scalable cash','currency_code','EUR','amount_minor','700','quantity_text',null,'unit_price_text',null,'cost_basis_minor',null,'as_of','2026-10-02')),'{"totalMinor":"700"}','2026-10-02T13:00:00Z');
  if not exists(select 1 from public.wealth_items where id=debt and removed_at is not null) then raise exception 'Cash back above zero should clear the debt'; end if;
end;
$$;
