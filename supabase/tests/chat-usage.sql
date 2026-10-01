do $$
declare u uuid := gen_random_uuid(); w uuid; c uuid := gen_random_uuid(); r uuid := gen_random_uuid(); canceled uuid := gen_random_uuid();
  usage_value jsonb := '{"model_id":"synthetic/free","input_tokens":0,"output_tokens":12,"total_tokens":null}';
begin
  insert into auth.users(id,email) values(u,'qa-'||u||'@example.invalid');
  select id into strict w from public.workspaces where owner_id=u;
  perform set_config('request.jwt.claim.sub',u::text,true);
  insert into public.conversations(id,workspace_id,title) values(c,w,'Synthetic usage');
  perform public.start_chat_request(r,c,'Synthetic question','{}');
  begin
    perform public.finish_chat_request(r,'completed','Answer','{"model_id":"synthetic/free","total_tokens":1.5}');
    raise exception 'Fractional token count must be refused';
  exception when sqlstate '22023' then null; end;
  perform public.finish_chat_request(r,'completed','Answer',usage_value);
  perform public.finish_chat_request(r,'completed','Different retry','{"model_id":"different"}');
  if (select usage from public.chat_requests where id=r) <> usage_value then raise exception 'Reported usage must persist once'; end if;
  if (select count(*) from public.messages where reply_to=r) <> 1 then raise exception 'Completion retry must not duplicate reply'; end if;
  perform public.start_chat_request(canceled,c,'Canceled question','{}');
  perform public.cancel_chat_request(canceled);
  perform public.finish_chat_request(canceled,'completed','Late answer',usage_value);
  if (select usage from public.chat_requests where id=canceled) is not null then raise exception 'Canceled completion must not save late usage'; end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.finish_chat_request(r,'completed','Foreign answer',usage_value);
    raise exception 'Foreign completion must be denied';
  exception when sqlstate 'P0002' then null; end;
end;
$$;
