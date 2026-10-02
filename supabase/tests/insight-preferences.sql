do $$
declare actor uuid:=gen_random_uuid(); foreign_actor uuid:=gen_random_uuid(); workspace uuid; foreign_workspace uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(foreign_actor,'qa-'||foreign_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict foreign_workspace from public.workspaces where owner_id=foreign_actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  insert into public.insight_preferences(workspace_id,minimum_change_minor,upcoming_days,max_items) values(workspace,9007199254740993,30,20);
  if (select minimum_change_minor::text from public.insight_preferences where workspace_id=workspace)<>'9007199254740993' then raise exception 'Insight threshold lost exactness'; end if;
  insert into public.insight_dismissals(workspace_id,evidence_key,insight_type) values(workspace,repeat('a',64),'cash_shortfall') on conflict do nothing;
  insert into public.insight_dismissals(workspace_id,evidence_key,insight_type) values(workspace,repeat('a',64),'cash_shortfall') on conflict do nothing;
  if (select count(*) from public.insight_dismissals where workspace_id=workspace)<>1 then raise exception 'Dismissal not deduplicated'; end if;
  begin
    insert into public.insight_dismissals(workspace_id,evidence_key,insight_type) values(foreign_workspace,repeat('b',64),'cash_shortfall');
    raise exception 'Foreign insight dismissed' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.insight_preferences(workspace_id) values(foreign_workspace);
    raise exception 'Foreign relevance preferences changed' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    update public.insight_preferences set upcoming_days=31 where workspace_id=workspace;
    raise exception 'Unbounded lookahead accepted' using errcode='ZX001';
  exception when check_violation then null; end;
  delete from public.insight_dismissals where workspace_id=workspace;
  if exists(select 1 from public.insight_dismissals where workspace_id=workspace) then raise exception 'Dismissal restore failed'; end if;
  execute 'reset role';
end;
$$;
