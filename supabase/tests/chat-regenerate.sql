do $$
declare
  u uuid := gen_random_uuid(); w uuid; c uuid := gen_random_uuid();
  q uuid := gen_random_uuid(); again uuid := gen_random_uuid(); newer uuid := gen_random_uuid(); late uuid := gen_random_uuid();
  older uuid := gen_random_uuid(); branch uuid := gen_random_uuid(); edited uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values(u,'qa-'||u||'@example.invalid');
  select id into strict w from public.workspaces where owner_id=u;
  perform set_config('request.jwt.claim.sub',u::text,true);
  insert into public.conversations(id,workspace_id,title) values(c,w,'Synthetic regenerate');
  perform public.start_chat_request(q,c,'Synthetic question','{}');
  perform public.finish_chat_request(q,'completed','First answer');
  perform public.start_chat_request(again,c,'Synthetic question','{}',q);
  perform public.finish_chat_request(again,'completed','Second answer');
  update public.chat_requests set created_at=created_at+interval '1 second' where id=again;
  if (select count(*) from public.messages where conversation_id=c and role='user') <> 1 then raise exception 'Regenerating must not add a second question'; end if;
  if (select count(*) from public.messages where conversation_id=c and role='assistant' and answer_of=q) <> 2 then raise exception 'Both answers must stay and belong to the first question'; end if;
  begin
    perform public.start_chat_request(late,c,'Another question','{}',q);
    raise exception 'A different question must not be regenerated as the first';
  exception when sqlstate '22023' then null; end;

  perform public.start_chat_request(newer,c,'Next question','{}');
  perform public.finish_chat_request(newer,'completed','Next answer');
  if (select parent_id from public.chat_requests where id=newer) is distinct from again then raise exception 'A new question must follow the newest answer'; end if;

  perform public.start_chat_request(older,c,'Synthetic question','{}',q);
  perform public.finish_chat_request(older,'completed','Third answer');
  if (select parent_id from public.chat_requests where id=older) is not null then raise exception 'An earlier question must stay regenerable and keep its place'; end if;

  perform public.start_chat_request(branch,c,'Branch question','{}',null,q);
  if (select parent_id from public.chat_requests where id=branch) is distinct from q then raise exception 'Continuing must follow the answer being viewed'; end if;
  if (select chat_request_id from public.messages where request_id=branch) is distinct from branch then raise exception 'A question must belong to its request'; end if;
  perform public.finish_chat_request(branch,'completed','Branch answer');

  perform public.start_chat_request(edited,c,'Edited question','{}',null,null,newer);
  if (select parent_id from public.chat_requests where id=edited) is distinct from again then raise exception 'An edit must branch where the edited question was asked'; end if;
  if (select content from public.messages where request_id=newer) <> 'Next question' then raise exception 'Editing must keep the original question'; end if;
  if (select content from public.messages where request_id=edited) <> 'Edited question' then raise exception 'An edit must save the new question'; end if;
end;
$$;
