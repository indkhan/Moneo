do $$
declare
  u uuid := gen_random_uuid(); w uuid; c uuid := gen_random_uuid();
  a uuid := gen_random_uuid(); t uuid := gen_random_uuid(); r uuid := gen_random_uuid(); r2 uuid := gen_random_uuid();
  result jsonb; completion text;
begin
  insert into auth.users(id,email) values(u,'qa-'||u||'@example.invalid');
  select id into strict w from public.workspaces where owner_id=u;
  perform set_config('request.jwt.claim.sub',u::text,true);
  insert into public.conversations(id,workspace_id,title) values(c,w,'Synthetic chat');
  insert into public.accounts(id,workspace_id,name,currency_code) values(a,w,'Synthetic cash','EUR');
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(t,w,a,'2026-10-01','Synthetic',-100,'EUR');
  result := public.start_chat_request(r,c,'Set category of transaction '||t||' to "Groceries"','{}');
  if result->>'started' <> 'true' then raise exception 'First request must claim execution'; end if;
  result := public.start_chat_request(r,c,'Set category of transaction '||t||' to "Groceries"','{}');
  if result->>'started' <> 'false' then raise exception 'Duplicate request must not claim execution'; end if;
  perform public.chat_set_category(r,t,'Groceries');
  perform public.chat_set_category(r,t,'Groceries');
  if (select count(*) from public.correction_events where transaction_id=t) <> 1 then raise exception 'Duplicate model writes must create one correction'; end if;
  perform public.cancel_chat_request(r);
  begin
    perform public.chat_set_category(r,t,'Groceries');
    raise exception 'Canceled requests must prevent writes';
  exception when sqlstate '57014' then null;
  end;
  -- The prose-chat contract allows owned completion, but cancellation still fences it.
  completion := public.finish_chat_request(r,'completed','Late owner answer');
  if completion <> 'canceled' then raise exception 'Owner completion must retain cancellation'; end if;
  if exists(select 1 from public.messages where reply_to=r) then raise exception 'Canceled owner completion must not publish'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.finish_verified_chat_request(r,u,w,'Late answer',array[]::uuid[],array[]::text[],null);
  perform set_config('request.jwt.claim.role','authenticated',true);
  if exists(select 1 from public.messages where reply_to=r) then raise exception 'Canceled request must not save late replies'; end if;
  perform public.start_chat_request(r2,c,'Change my Amazon to Groceries','{}');
  begin
    perform public.chat_set_category(r2,t,'Groceries');
    raise exception 'Ambiguous prose must not authorize a model target';
  exception when sqlstate '22023' then null;
  end;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.finish_chat_request(r2,'completed','Foreign reply');
    raise exception 'Foreign workspace completion must be refused';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform public.cancel_chat_request(r2);
    raise exception 'Foreign workspace cancellation must be refused';
  exception when sqlstate 'P0002' then null;
  end;
  perform set_config('request.jwt.claim.sub',u::text,true);
  completion := public.finish_chat_request(r2,'completed','Owned prose answer',
    '{"model_id":"synthetic-model","input_tokens":1,"output_tokens":2,"total_tokens":3}',
    '[{"name":"synthetic_tool","input":{},"output":{}}]');
  if completion <> 'completed' or (select count(*) from public.messages where reply_to=r2 and content='Owned prose answer') <> 1
    or (select usage->>'total_tokens' from public.chat_requests where id=r2) <> '3'
    or (select tool_calls->0->>'name' from public.chat_requests where id=r2) <> 'synthetic_tool' then
    raise exception 'Owned prose completion must retain its answer, usage and tool calls';
  end if;
end;
$$;
