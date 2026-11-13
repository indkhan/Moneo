-- Two triggers racing for one bank connection: only one gets the lease, and a run whose lease ran out can't finish.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; bank uuid:=gen_random_uuid(); first uuid:=gen_random_uuid(); second uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.bank_connections(id,workspace_id,aspsp_name,aspsp_country,status,session_id_encrypted,valid_until) values(bank,workspace,'Test Bank','DE','active','sealed',now()+interval '30 days');

  if not public.claim_bank_sync(bank,workspace,first) then raise exception 'A free connection was not claimed'; end if;
  if (select sync_started_at from public.bank_connections where id=bank) is null then raise exception 'A claimed sync is not shown as running'; end if;
  if public.claim_bank_sync(bank,workspace,second) then raise exception 'A second trigger got a held lease'; end if;
  if not public.hold_bank_sync(bank,first) then raise exception 'The holder could not keep its lease'; end if;
  if public.hold_bank_sync(bank,second) then raise exception 'A non-holder kept a lease'; end if;

  -- The first run crashed: its lease runs out, the next trigger takes over, and the old run can't hold it again.
  update public.bank_connections set sync_lease_until=now()-interval '1 second' where id=bank;
  if public.hold_bank_sync(bank,first) then raise exception 'A run-out lease was kept'; end if;
  if not public.claim_bank_sync(bank,workspace,second) then raise exception 'A run-out lease was not taken over'; end if;
  if public.hold_bank_sync(bank,first) then raise exception 'The old holder kept a taken-over lease'; end if;

  update public.bank_connections set sync_lease_token=null,sync_lease_until=null,status='expired' where id=bank;
  if public.claim_bank_sync(bank,workspace,first) then raise exception 'An ended connection was claimed'; end if;
  if has_function_privilege('authenticated','public.claim_bank_sync(uuid,uuid,uuid)','execute') then raise exception 'Owners must not take sync leases directly'; end if;
end;
$$;
