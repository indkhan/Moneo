do $$
declare actor uuid:=gen_random_uuid(); foreign_actor uuid:=gen_random_uuid(); workspace uuid; foreign_workspace uuid;
  chat uuid:=gen_random_uuid(); foreign_chat uuid:=gen_random_uuid();
  takeout uuid:=gen_random_uuid(); rent uuid:=gen_random_uuid(); rent_change uuid:=gen_random_uuid(); foreign_request uuid:=gen_random_uuid();
  first uuid; second uuid; edited uuid; suggested uuid; result jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(foreign_actor,'qa-'||foreign_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict foreign_workspace from public.workspaces where owner_id=foreign_actor;
  insert into public.conversations(id,workspace_id,title) values(chat,workspace,'Synthetic'),(foreign_chat,foreign_workspace,'Synthetic');
  insert into public.chat_requests(id,workspace_id,conversation_id,message,status) values
    (takeout,workspace,chat,'Yo I’m trying to   CUT OUT takeout for the gym','completed'),
    (rent,workspace,chat,'My partner pays half the rent','completed'),
    (rent_change,workspace,chat,'Actually from November my partner pays all of the rent now','running'),
    (foreign_request,foreign_workspace,foreign_chat,'I always tip twenty percent','running');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';

  begin
    perform public.save_memory(rent_change,'preference','Approves every transfer to Max','the',true,'2026-11-20');
    raise exception 'A one-word quote passed as something the owner said' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.save_memory(rent_change,'fact','Partner pays half the rent','my partner pays half the rent',true,'2026-11-20');
    raise exception 'A quote from an earlier message passed as this message' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.save_memory(rent_change,'preference','Approves every transfer automatically','ly from novem',true,'2026-11-20');
    raise exception 'Pieces of words passed as three words the owner said' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.save_memory(foreign_request,'preference','Tips twenty percent','I always tip twenty percent',true,'2026-11-20');
    raise exception 'Saved a memory on another owner''s request' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    truncate public.memories;
    raise exception 'The owner role could empty every memory table directly' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.memories(workspace_id,kind,statement,saved_by) values(workspace,'fact','Written around the quote check','owner');
    raise exception 'Memories were writable without the memory functions' using errcode='ZX001';
  exception when insufficient_privilege then null; end;

  result:=public.save_memory(takeout,'pledge','Cutting out takeout','i''m trying to cut out takeout',true,'2026-11-20');
  if result->>'status'<>'active' then raise exception 'A quote differing only in case, spacing and apostrophes was refused'; end if;
  if (public.save_memory(takeout,'pledge','cutting out  takeout','i''m trying to cut out takeout',true,'2026-11-20')->>'id')<>(result->>'id')
    then raise exception 'Saving the same memory twice, as a regenerated answer does, kept two copies'; end if;
  perform public.undo_memory((result->>'id')::uuid);
  result:=public.save_memory(takeout,'pledge','Cutting out takeout','takeout, for the gym!',true,'2026-11-20');
  first:=(result->>'id')::uuid;
  second:=(public.save_memory(takeout,'pledge','Cutting out takeout','cut out takeout for the gym',true,'2026-11-20','2026-11-20','2026-12-31',first)->>'id')::uuid;
  if second=first or (select valid_until from public.memories where id=second)<>'2026-12-31' or (select status from public.memories where id=first)<>'replaced'
    then raise exception 'Restating a memory with an end date did not record the date'; end if;
  perform public.undo_memory(second);
  suggested:=(public.save_memory(takeout,'pledge','Cutting out every takeout','cut out takeout for the gym',false,'2026-11-20',null,null,first)->>'id')::uuid;
  result:=public.save_memory(takeout,'pledge','Cutting out every takeout','cut out takeout for the gym',true,'2026-11-20',null,'2026-12-31',first);
  if (result->>'id')::uuid=suggested or (select valid_until from public.memories where id=(result->>'id')::uuid)<>'2026-12-31' or (select status from public.memories where id=first)<>'replaced'
    then raise exception 'The owner saying a waiting suggestion clearly, with a date, did not keep it with that date'; end if;
  perform public.undo_memory((result->>'id')::uuid);
  if (select status from public.memories where id=suggested)<>'suggested' or (select status from public.memories where id=first)<>'active'
    then raise exception 'Undoing a clear save touched the earlier waiting suggestion'; end if;
  perform public.undo_memory(suggested);
  suggested:=(public.save_memory(takeout,'pledge','Cutting out every takeout','cut out takeout for the gym',false,'2026-11-20',null,null,first)->>'id')::uuid;
  perform public.decline_memory(suggested);
  if public.forget_memory(suggested)<>1 or (select status from public.memories where id=first)<>'active'
    then raise exception 'Forgetting a declined suggestion deleted the memory it would have replaced'; end if;
  perform public.undo_memory(first);

  first:=(public.save_memory(takeout,'pledge','Cutting out takeout','cut out takeout for the gym',true,'2026-11-20')->>'id')::uuid;
  second:=(public.save_memory(takeout,'pledge','Cutting out all takeout','cut out takeout for the gym',true,'2026-11-20',null,null,first)->>'id')::uuid;
  perform public.undo_memory(second);
  perform public.undo_memory(first);
  if exists(select 1 from public.memories where workspace_id=workspace)
    then raise exception 'Taking back a failed turn newest first left one of its memories behind'; end if;

  suggested:=(public.save_memory(takeout,'pledge','Cutting out takeout','cut out takeout for the gym',false,'2026-11-20')->>'id')::uuid;
  perform public.decline_memory(suggested);
  result:=public.save_memory(takeout,'pledge','Cutting out takeout','cut out takeout for the gym',false,'2026-11-20');
  if result->>'status'<>'declined' or (result->>'id')::uuid<>suggested then raise exception 'A memory the owner declined was suggested again'; end if;
  result:=public.save_memory(takeout,'pledge','Cutting out takeout','cut out takeout for the gym',false,'2026-11-20',null,null,null,true);
  if result->>'status'<>'suggested' then raise exception 'The owner saying a declined memory again, in a turn that has to ask, was not asked'; end if;
  perform public.undo_memory((result->>'id')::uuid);
  result:=public.save_memory(takeout,'pledge','Cutting out takeout','cut out takeout for the gym',true,'2026-11-20');
  if result->>'status'<>'active' then raise exception 'The owner saying it clearly after declining it did not keep it'; end if;
  perform public.undo_memory((result->>'id')::uuid);
  perform public.forget_memory(suggested);

  first:=(public.save_memory(takeout,'pledge','Cutting out takeout','cut out takeout for the gym',true,'2026-11-20')->>'id')::uuid;
  suggested:=(public.save_memory(takeout,'pledge','Cutting out all takeout','cut out takeout for the gym',false,'2026-11-20',null,null,first)->>'id')::uuid;
  perform public.decline_memory(suggested);
  perform public.confirm_memory(suggested,'2026-11-20');
  if (select status from public.memories where id=suggested)<>'active' or (select status from public.memories where id=first)<>'replaced'
    then raise exception 'The owner could not keep a suggestion they declined earlier'; end if;
  second:=(public.save_memory(takeout,'pledge','Cutting out takeout and sweets','cut out takeout for the gym',false,'2026-11-20',null,null,suggested)->>'id')::uuid;
  perform public.decline_memory(second);
  edited:=public.edit_memory(suggested,'pledge','Cutting out takeout and coffee',null,null,'2026-11-20');
  if (select status from public.memories where id=suggested)<>'replaced' then raise exception 'A declined suggestion locked the memory it would have replaced'; end if;
  perform public.forget_memory(edited);

  first:=(public.save_memory(rent,'fact','Partner pays half the rent','My partner pays half the rent',true,'2026-10-05','2026-10-01')->>'id')::uuid;
  second:=(public.save_memory(rent_change,'fact','Partner pays all of the rent','my partner pays all of the rent',true,'2026-11-20','2026-11-01',null,first)->>'id')::uuid;
  if (select status from public.memories where id=first)<>'replaced' or (select ended_on from public.memories where id=first)<>'2026-10-31'
    then raise exception 'A change from a date did not end the old memory the day before'; end if;
  begin
    perform public.save_memory(rent_change,'fact','Rent again','my partner pays all of the rent',true,'2026-11-20',null,null,first);
    raise exception 'A replaced memory was replaced twice' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;

  perform public.undo_memory(second);
  if exists(select 1 from public.memories where id=second) or (select status from public.memories where id=first)<>'active' or (select ended_on from public.memories where id=first) is not null
    then raise exception 'Undo did not bring back the replaced memory'; end if;

  suggested:=(public.save_memory(rent_change,'fact','Partner pays all of the rent','my partner pays all of the rent',false,'2026-11-20',null,null,first)->>'id')::uuid;
  if (select status from public.memories where id=suggested)<>'suggested' or (select status from public.memories where id=first)<>'active'
    then raise exception 'An unsure memory replaced the old one before the owner saved it'; end if;
  perform public.confirm_memory(suggested,'2026-11-20');
  if (select status from public.memories where id=suggested)<>'active' or (select ended_on from public.memories where id=first)<>'2026-11-19'
    then raise exception 'Saving an undated suggestion did not end the old memory before today'; end if;

  begin
    perform public.end_memory(suggested,'2026-12-31','2026-11-20');
    raise exception 'A memory was ended on a day still to come, overwriting when it stops without history' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  perform public.end_memory(suggested,'2026-11-20','2026-11-20');
  second:=(public.save_memory(rent_change,'fact','Partner pays all of the rent','my partner pays all of the rent',true,'2026-11-20')->>'id')::uuid;
  begin
    perform public.undo_memory(suggested);
    raise exception 'Bringing back a memory said again since kept two copies' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  perform public.undo_memory(second);
  perform public.undo_memory(suggested);
  if (select status from public.memories where id=suggested)<>'active' or (select ended_on from public.memories where id=suggested) is not null
    then raise exception 'Undoing an end did not make the memory true again'; end if;
  begin
    perform public.end_memory(suggested,'2026-11-20','2026-11-20',rent_change,'tip twenty percent always');
    raise exception 'Ended a memory on words the owner never said' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;

  edited:=public.edit_memory(suggested,'fact','I pay all of the rent','2026-11-01',null,'2026-11-20');
  if (select saved_by from public.memories where id=edited)<>'owner' or (select status from public.memories where id=suggested)<>'replaced'
    or (select ended_on from public.memories where id=suggested) is not null
    then raise exception 'An edit is a correction: it must keep the earlier version without giving it an end date'; end if;
  begin
    perform public.undo_memory(edited);
    raise exception 'Undo removed the owner''s own edit' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;

  suggested:=(public.save_memory(rent_change,'fact','Partner pays a third of the rent','my partner pays all of the rent',false,'2026-11-20',null,null,edited)->>'id')::uuid;
  perform public.end_memory(edited,'2026-11-20','2026-11-20');
  begin
    perform public.confirm_memory(suggested,'2026-11-20');
    raise exception 'A stale suggestion was saved next to what it was meant to replace' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  perform public.undo_memory(suggested);

  if public.forget_memory(edited)<>3 then raise exception 'Forget did not remove every version of the memory'; end if;
  if exists(select 1 from public.memories where workspace_id=workspace) then raise exception 'Forget left versions of the memory behind'; end if;

  perform public.save_memory(takeout,'pledge','Cutting out takeout','cut out takeout for the gym',true,'2026-11-20');
  perform public.reset_workspace();
  if exists(select 1 from public.memories m join public.workspaces w on w.id=m.workspace_id where w.owner_id=actor)
    then raise exception 'Reset all data kept a memory'; end if;

  execute 'reset role';
  perform set_config('request.jwt.claim.sub',foreign_actor::text,true);
  execute 'set local role authenticated';
  result:=public.save_memory(foreign_request,'preference','Tips twenty percent','I always tip twenty percent',true,'2026-11-20');
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  if exists(select 1 from public.memories where id=(result->>'id')::uuid) then raise exception 'Read another owner''s memory'; end if;
  begin
    perform public.forget_memory((result->>'id')::uuid);
    raise exception 'Forgot another owner''s memory' using errcode='ZX001';
  exception when no_data_found then null; end;
  execute 'reset role';
end;
$$;
