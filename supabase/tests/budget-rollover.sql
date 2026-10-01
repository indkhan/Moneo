do $$
declare u uuid:=gen_random_uuid(); w uuid; c uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); e uuid; e2 uuid; month date;
begin
 insert into auth.users(id,email) values(u,'qa-'||u||'@example.invalid');
 select id into strict w from public.workspaces where owner_id=u;
 perform set_config('request.jwt.claim.sub',u::text,true);
 month:=date_trunc('month',now() at time zone 'Europe/Berlin')::date;
 insert into public.categories(id,workspace_id,name) values(c,w,'Synthetic rollover');
 insert into public.spending_plans(id,workspace_id,category_id,currency_code,limit_minor) values(p,w,c,'EUR',10000);
 if not exists(select 1 from public.spending_plan_limits where plan_id=p and version=1 and effective_month=month and limit_minor=10000) then raise exception 'Initial target evidence missing'; end if;
 e:=public.edit_spending_plan(p,1,jsonb_build_object('rollover',true,'rollover_from',month::text),r);
 if public.edit_spending_plan(p,1,jsonb_build_object('rollover',true,'rollover_from',month::text),r)<>e then raise exception 'Rollover retry lost receipt'; end if;
 e2:=public.edit_spending_plan(p,2,'{"limit_minor":"9007199254740993"}',gen_random_uuid());
 begin perform public.undo_planning_event(e,3); raise exception 'Older rollover undo erased newer target'; exception when sqlstate '40001' then null; end;
 perform public.undo_planning_event(e2,3);
 perform public.undo_planning_event(e,4);
 if not exists(select 1 from public.spending_plans where id=p and not rollover and limit_minor=10000 and version=5) then raise exception 'Sequential budget undo failed'; end if;
 if (select count(*) from public.spending_plan_limits where plan_id=p)<>5 then raise exception 'Restoration target evidence must remain immutable'; end if;
 if (select limit_minor::text from public.spending_plan_limits where plan_id=p and version=3)<>'9007199254740993' then raise exception 'Target history lost exact original'; end if;
 execute 'set local role authenticated';
 begin update public.spending_plan_limits set limit_minor=1 where plan_id=p; raise exception 'Target history is mutable'; exception when insufficient_privilege then null; end;
 execute 'reset role';
end $$;
