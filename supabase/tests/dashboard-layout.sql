do $$
declare u uuid:=gen_random_uuid(); other_user uuid:=gen_random_uuid(); w uuid; other_workspace uuid;
begin
  insert into auth.users(id,email) values(u,'qa-'||u||'@example.invalid'),(other_user,'qa-'||other_user||'@example.invalid');
  select id into strict w from public.workspaces where owner_id=u;
  select id into strict other_workspace from public.workspaces where owner_id=other_user;
  insert into public.dashboard_layouts(workspace_id,items) values(w,array['accounts','overview']), (other_workspace,array['goals']);
  perform set_config('request.jwt.claim.sub',u::text,true);
  execute 'set local role authenticated';
  if (select count(*) from public.dashboard_layouts where workspace_id=other_workspace)<>0 then raise exception 'Foreign dashboard must be hidden'; end if;
  update public.dashboard_layouts set items=array['overview'],version=2 where workspace_id=w and version=1;
  if not found then raise exception 'Expected dashboard version must save'; end if;
  update public.dashboard_layouts set items=array['accounts'],version=2 where workspace_id=w and version=1;
  if found then raise exception 'Stale dashboard version must not overwrite'; end if;
  update public.dashboard_layouts set items='{}' where workspace_id=other_workspace;
  if found then raise exception 'Foreign dashboard must not be updated'; end if;
  execute 'reset role';
end;
$$;
