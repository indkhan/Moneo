do $$
declare
  u uuid := gen_random_uuid(); w uuid; c uuid := gen_random_uuid();
  q uuid := gen_random_uuid(); again uuid := gen_random_uuid(); newer uuid := gen_random_uuid(); late uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values(u,'qa-'||u||'@example.invalid');
  select id into strict w from public.workspaces where owner_id=u;
  perform set_config('request.jwt.claim.sub',u::text,true);
  insert into public.conversations(id,workspace_id,title) values(c,w,'Synthetic regenerate');
  perform public.start_chat_request(q,c,'Synthetic question','{}');
  perform public.finish_chat_request(q,'completed','First answer');
  perform public.start_chat_request(again,c,'Synthetic question','{}',q);
  perform public.finish_chat_request(again,'completed','Second answer');
  if (select count(*) from public.messages where conversation_id=c and role='user') <> 1 then raise exception 'Regenerating must not add a second question'; end if;
  if (select count(*) from public.messages where conversation_id=c and role='assistant' and answer_of=q) <> 2 then raise exception 'Both answers must stay and belong to the first question'; end if;
  begin
    perform public.start_chat_request(late,c,'Another question','{}',q);
    raise exception 'A different question must not be regenerated as the first';
  exception when sqlstate '22023' then null; end;
  perform public.start_chat_request(newer,c,'Next question','{}');
  update public.messages set created_at=created_at+interval '1 second' where request_id=newer;
  begin
    perform public.start_chat_request(late,c,'Synthetic question','{}',q);
    raise exception 'Only the latest reply can be regenerated';
  exception when sqlstate '22023' then null; end;
end;
$$;
