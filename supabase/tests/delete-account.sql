-- Synthetic users only. The migration runner executes this inside a rollback.
do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_b uuid;
  account_a uuid := gen_random_uuid();
  categories_b integer;
  total integer;
begin
  insert into auth.users(id,email) values(user_a,'qa-'||user_a||'@example.invalid'),(user_b,'qa-'||user_b||'@example.invalid');
  select id into strict workspace_b from public.workspaces where owner_id=user_b;
  select count(*) into categories_b from public.categories where workspace_id=workspace_b;
  insert into public.accounts(id,workspace_id,name,currency_code) select account_a,id,'Synthetic','EUR' from public.workspaces where owner_id=user_a;

  perform set_config('request.jwt.claim.sub', user_a::text, true);
  perform public.delete_account();

  select count(*) into total from auth.users where id=user_a;
  if total<>0 then raise exception 'Delete left the auth user'; end if;
  select count(*) into total from public.workspaces where owner_id=user_a;
  if total<>0 then raise exception 'Delete left the workspace'; end if;
  select count(*) into total from public.accounts where id=account_a;
  if total<>0 then raise exception 'Delete left an account'; end if;

  select count(*) into total from auth.users where id=user_b;
  if total<>1 then raise exception 'Delete removed another user'; end if;
  select count(*) into total from public.categories where workspace_id=workspace_b;
  if total<>categories_b then raise exception 'Delete changed another workspace'; end if;

  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.delete_account();
    raise exception 'Anonymous delete succeeded' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
end;
$$;
