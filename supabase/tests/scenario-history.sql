do $$
declare u uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); w uuid; other_w uuid; foreign_s uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); e uuid; e2 uuid; count_before integer;
begin
 insert into auth.users(id,email) values(u,'qa-'||u||'@example.invalid'); select id into strict w from public.workspaces where owner_id=u; perform set_config('request.jwt.claim.sub',u::text,true);
 insert into public.accounts(id,workspace_id,name,type,currency_code) values(a,w,'Scenario cash','checking','EUR');
 insert into public.scenarios(id,workspace_id,name) values(s,w,'Synthetic comparison');
 insert into auth.users(id,email) values(other,'qa-'||other||'@example.invalid'); select id into strict other_w from public.workspaces where owner_id=other;
 insert into public.scenarios(id,workspace_id,name) values(foreign_s,other_w,'Foreign scenario');
 begin insert into public.scenario_overrides(workspace_id,scenario_id,account_id,name,amount_delta_minor,currency_code,cadence,starts_on) values(w,foreign_s,a,'Foreign relationship',-100,'EUR','once','2026-10-01'); raise exception 'Cross-workspace scenario relationship accepted'; exception when sqlstate '22023' then null; end;
 insert into public.scenario_overrides(id,workspace_id,scenario_id,account_id,name,amount_delta_minor,currency_code,cadence,starts_on) values(o,w,s,a,'Synthetic event',-10000,'EUR','once','2026-10-01');
 select count(*) into count_before from public.transactions where workspace_id=w;
 e:=public.edit_scenario_record('override',o,1,'{"amount_delta_minor":"-9007199254740993","name":" Exact scenario "}',r);
 if public.edit_scenario_record('override',o,1,'{"amount_delta_minor":"-9007199254740993","name":" Exact scenario "}',r)<>e then raise exception 'Scenario retry duplicated event'; end if;
 if (select after->>'amount_delta_minor' from public.scenario_events where id=e)<>'-9007199254740993' then raise exception 'Scenario audit rounded money'; end if;
 e2:=public.edit_scenario_record('override',o,2,'{"removed":true}',gen_random_uuid());
 begin perform public.undo_scenario_record(e,3); raise exception 'Older undo overwrote scenario removal'; exception when sqlstate '40001' then null; end;
 perform public.undo_scenario_record(e2,3); perform public.undo_scenario_record(e,4);
 if not exists(select 1 from public.scenario_overrides where id=o and amount_delta_minor=-10000 and removed_at is null and version=5) then raise exception 'Scenario sequential undo lost source assumptions'; end if;
 if (select count(*) from public.transactions where workspace_id=w)<>count_before then raise exception 'Scenario changed actual ledger'; end if;
 perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
 begin perform public.edit_scenario_record('override',o,5,'{"name":"Foreign edit"}',gen_random_uuid()); raise exception 'Foreign scenario edit accepted'; exception when sqlstate 'P0002' then null; end;
end $$;
