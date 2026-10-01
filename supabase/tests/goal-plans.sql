do $$
declare u uuid:=gen_random_uuid(); w uuid; g uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); e uuid; e2 uuid;
  patch jsonb:='{"priority":1,"planned_monthly_minor":"3000","contribution_starts_on":"2026-01-31","recorded_saved_minor":"1000","saved_as_of":"2026-01-31","target_minor":"9007199254740993"}';
begin
  insert into auth.users(id,email) values(u,'qa-'||u||'@example.invalid');
  select id into strict w from public.workspaces where owner_id=u;
  perform set_config('request.jwt.claim.sub',u::text,true);
  insert into public.goals(id,workspace_id,name,target_minor,currency_code) values(g,w,'Synthetic goal',10000,'EUR');
  begin
    insert into public.goals(workspace_id,name,target_minor,currency_code,recorded_saved_minor,saved_as_of) values(w,'Future evidence',10000,'EUR',1000,current_date+10);
    raise exception 'Direct insertion of future savings must fail';
  exception when sqlstate '22023' then null; end;
  e:=public.edit_goal_plan(g,0,patch,r);
  if public.edit_goal_plan(g,0,patch,r)<>e then raise exception 'Goal retry must reuse history'; end if;
  if (select after->>'target_minor' from public.goal_events where id=e)<>'9007199254740993' then raise exception 'Goal history must preserve exact money'; end if;
  begin perform public.edit_goal_plan(g,0,'{"priority":2}',gen_random_uuid()); raise exception 'Stale goal edit must fail'; exception when sqlstate '40001' then null; end;
  begin perform public.edit_goal_plan(g,1,'{"recorded_saved_minor":"2000","saved_as_of":null}',gen_random_uuid()); raise exception 'Recorded savings need a date'; exception when check_violation then null; end;
  e2:=public.edit_goal_plan(g,1,'{"priority":2}',gen_random_uuid());
  begin perform public.undo_goal_plan(e,2); raise exception 'Older goal change must not overwrite newer edit'; exception when sqlstate '40001' then null; end;
  perform public.undo_goal_plan(e2,2);
  perform public.undo_goal_plan(e,3);
  if (select target_minor from public.goals where id=g)<>10000 or (select recorded_saved_minor from public.goals where id=g) is not null then raise exception 'Sequential undo must restore original goal'; end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin perform public.edit_goal_plan(g,4,'{"priority":3}',gen_random_uuid()); raise exception 'Foreign goal edit must fail'; exception when sqlstate 'P0002' then null; end;
end;
$$;
