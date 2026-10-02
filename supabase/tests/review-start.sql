do $$
declare actor uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid(); workspace uuid; conversation uuid; chat_id uuid:=gen_random_uuid(); canceled_chat uuid:=gen_random_uuid(); question_chat uuid:=gen_random_uuid(); request_id uuid:=gen_random_uuid(); receipt jsonb; replay jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(other_actor,'qa-'||other_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.conversations(workspace_id,title) values(workspace,'Synthetic review intent') returning id into conversation;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  receipt:=public.start_financial_review(request_id,null);
  replay:=public.start_financial_review(request_id,null);
  if (receipt->>'started')::boolean is distinct from true or (replay->>'started')::boolean is distinct from false or receipt->>'jobId' is distinct from replay->>'jobId' then raise exception 'Review start idempotence failed'; end if;
  perform public.start_chat_request(chat_id,conversation,'Please run a deep financial review.','{}');
  receipt:=public.start_financial_review(gen_random_uuid(),chat_id);
  if (receipt->>'started')::boolean is distinct from true then raise exception 'Direct review command did not create a job'; end if;
  perform public.start_chat_request(canceled_chat,conversation,'Review my finances','{}');
  perform public.cancel_chat_request(canceled_chat);
  begin
    perform public.start_financial_review(gen_random_uuid(),canceled_chat);
    raise exception 'Canceled chat spawned a new review' using errcode='ZX001';
  exception when query_canceled then null; end;
  perform public.start_chat_request(question_chat,conversation,'What does a financial review do?','{}');
  begin
    perform public.start_financial_review(gen_random_uuid(),question_chat);
    raise exception 'Question authorized a persistent job' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.start_financial_review(request_id,chat_id);
    raise exception 'Review request changed its parent identity' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  perform set_config('request.jwt.claim.sub',other_actor::text,true);
  begin
    perform public.start_financial_review(gen_random_uuid(),chat_id);
    raise exception 'Foreign parent chat authorized a review' using errcode='ZX001';
  exception when no_data_found then null; end;
  execute 'reset role';
end;
$$;
