-- The AI usage ledger: owner-only read, service-role writes, unreported counts stay null, and reset removes it.
-- Synthetic data only; the runner rolls this back.
do $$
declare
  actor uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid(); workspace uuid; other_workspace uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(stranger,'qa-'||stranger||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict other_workspace from public.workspaces where owner_id=stranger;
  insert into public.ai_usage(workspace_id,task,model_id,source,input_tokens,output_tokens,duration_ms,status) values
    (workspace,'chat','gpt-test','chatgpt',0,null,120,'succeeded'),
    (other_workspace,'titles','gpt-test','openai',5,5,80,'succeeded');
  if (select output_tokens from public.ai_usage where workspace_id=workspace) is not null or (select input_tokens from public.ai_usage where workspace_id=workspace)<>0 then
    raise exception 'An unreported count was stored as zero or a reported zero was lost';
  end if;
  begin
    insert into public.ai_usage(workspace_id,task,model_id,source,status) values(workspace,'chat','m','somewhere','succeeded');
    raise exception 'An unknown provider was accepted' using errcode='ZX001';
  exception when check_violation then null; end;

  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  if (select count(*) from public.ai_usage)<>1 then raise exception 'Owner does not see exactly their own usage'; end if;
  begin
    insert into public.ai_usage(workspace_id,task,model_id,source,status) values(workspace,'chat','m','openai','succeeded');
    raise exception 'Owner wrote a usage row' using errcode='ZX001';
  exception when insufficient_privilege then null; end;

  perform public.reset_workspace();
  execute 'reset role';
  if exists(select 1 from public.ai_usage where workspace_id=workspace) then raise exception 'Reset left AI usage behind'; end if;
  if not exists(select 1 from public.ai_usage where workspace_id=other_workspace) then raise exception 'Reset removed another workspace''s usage'; end if;
end $$;
