-- Settings "Delete account": permanently remove the caller, their workspace and everything in it.
-- reset_workspace() already empties every workspace table in dependency order, so this reuses it and
-- removes the replacement workspace it creates. One transaction: a failure deletes nothing.
create function public.delete_account() returns void language plpgsql security definer set search_path='' as $$
declare owner uuid := auth.uid();
begin
  if owner is null then raise exception 'Unauthorized' using errcode='42501'; end if;
  perform public.reset_workspace();
  delete from public.workspace_settings where workspace_id in (select id from public.workspaces where owner_id=owner);
  delete from public.categories where workspace_id in (select id from public.workspaces where owner_id=owner);
  delete from public.workspaces where owner_id=owner;
  delete from auth.users where id=owner;
end;
$$;
revoke all on function public.delete_account() from public,anon;
grant execute on function public.delete_account() to authenticated;
