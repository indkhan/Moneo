do $$
declare u uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); w uuid; a uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); e jsonb; e2 jsonb;
  patch jsonb:='{"currency_code":"EUR","safety_buffer_minor":"9007199254740993","daily_spending_minor":"1000","uncertainty_bps":1000,"spending_account_id":null,"spending_starts_on":"2026-10-01"}';
begin
 insert into auth.users(id,email) values(u,'qa-'||u||'@example.invalid'),(other,'qa-'||other||'@example.invalid');
 select id into strict w from public.workspaces where owner_id=u;
 perform set_config('request.jwt.claim.sub',u::text,true);
 insert into public.accounts(id,workspace_id,name,type,currency_code) values(a,w,'Synthetic cash','checking','EUR');
 patch:=patch||jsonb_build_object('spending_account_id',a);
 e:=public.edit_forecast_preferences(w,patch,0,r);
 if public.edit_forecast_preferences(w,patch,0,r)<>e then raise exception 'Retry must reuse preference event'; end if;
 if (select after->>'safety_buffer_minor' from public.forecast_preference_events where id=(e->>'eventId')::uuid)<>'9007199254740993' then raise exception 'Buffer history must preserve exact money'; end if;
 begin perform public.edit_forecast_preferences(w,patch||'{"uncertainty_bps":0}',0,gen_random_uuid()); raise exception 'Stale preference edit must fail'; exception when sqlstate '40001' then null; end;
 begin perform public.edit_forecast_preferences(w,patch||'{"safety_buffer_minor":9007199254740993}',1,gen_random_uuid()); raise exception 'JSON number must not masquerade as exact money'; exception when sqlstate '22023' then null; end;
 begin perform public.edit_forecast_preferences(w,patch||'{"currency_code":"ZZZ"}',1,gen_random_uuid()); raise exception 'Unknown precision must fail'; exception when sqlstate '22023' then null; end;
 begin perform public.edit_forecast_preferences(w,patch||'{"spending_starts_on":"today"}',1,gen_random_uuid()); raise exception 'Relative date must fail'; exception when sqlstate '22023' then null; end;
 begin perform public.edit_forecast_preferences(w,patch||'{"spending_account_id":null}',1,gen_random_uuid()); raise exception 'Spending needs its account'; exception when check_violation then null; end;
 e2:=public.edit_forecast_preferences(w,patch||'{"safety_buffer_minor":"500"}',1,gen_random_uuid());
 begin perform public.undo_forecast_preferences((e->>'eventId')::uuid,2); raise exception 'Older change must not erase newer preferences'; exception when sqlstate '40001' then null; end;
 perform public.undo_forecast_preferences((e2->>'eventId')::uuid,2);
 perform public.undo_forecast_preferences((e->>'eventId')::uuid,3);
 if (select safety_buffer_minor from public.forecast_preferences where workspace_id=w)<>0 or (select daily_spending_minor from public.forecast_preferences where workspace_id=w)<>0 then raise exception 'Undo initial edit must restore disabled defaults'; end if;
 perform set_config('request.jwt.claim.sub',other::text,true);
 begin perform public.edit_forecast_preferences(w,patch,4,gen_random_uuid()); raise exception 'Foreign preferences must fail'; exception when sqlstate 'P0002' then null; end;
end $$;
