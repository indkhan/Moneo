alter table public.transactions add column version integer not null default 0;

-- Canonical corrections must pass through these functions so every edit has an audit row.
revoke update, delete on public.transactions from public, authenticated;
revoke insert, update, delete on public.correction_events from public, authenticated;

create function public.correct_transaction(
  p_transaction_id uuid,
  p_expected_version integer,
  p_category_name text,
  p_note text
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  old_row public.transactions%rowtype;
  new_row public.transactions%rowtype;
  new_category_id uuid;
  category_name text := nullif(btrim(p_category_name), '');
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if length(category_name) > 100 or length(p_note) > 2000 then
    raise exception 'Correction is too long' using errcode = '22001';
  end if;

  select * into old_row from public.transactions
  where id = p_transaction_id and public.owns_workspace(workspace_id)
  for update;
  if not found then
    raise exception 'Transaction not found' using errcode = 'P0002';
  end if;
  if old_row.version is distinct from p_expected_version then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;

  if category_name is not null then
    insert into public.categories (workspace_id, name)
    values (old_row.workspace_id, category_name)
    on conflict (workspace_id, name) do update set name = excluded.name
    returning id into new_category_id;
  end if;

  update public.transactions
  set category_id = new_category_id, note = p_note, version = version + 1
  where id = p_transaction_id
  returning * into new_row;

  insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
  values (
    old_row.workspace_id, old_row.id, actor,
    jsonb_build_object('category_id', old_row.category_id, 'note', old_row.note, 'version', old_row.version),
    jsonb_build_object('category_id', new_row.category_id, 'note', new_row.note, 'version', new_row.version)
  );
  return new_row;
end;
$$;

create function public.undo_transaction_correction(
  p_event_id uuid,
  p_expected_version integer
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  event_row public.correction_events%rowtype;
  old_row public.transactions%rowtype;
  new_row public.transactions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into event_row from public.correction_events
  where id = p_event_id and public.owns_workspace(workspace_id);
  if not found then
    raise exception 'Correction not found' using errcode = 'P0002';
  end if;

  select * into old_row from public.transactions
  where id = event_row.transaction_id and workspace_id = event_row.workspace_id
  for update;
  if old_row.version is distinct from p_expected_version then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;

  select * into event_row from public.correction_events
  where id = p_event_id and not undone and not exists (
    select 1 from public.correction_events newer
    where newer.transaction_id = correction_events.transaction_id
      and not newer.undone
      and (newer.after->>'version')::integer > (correction_events.after->>'version')::integer
  );
  if not found then
    raise exception 'Only the latest correction can be undone' using errcode = '40001';
  end if;
  if old_row.category_id is distinct from (event_row.after->>'category_id')::uuid
     or old_row.note is distinct from event_row.after->>'note' then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;

  update public.transactions
  set category_id = (event_row.before->>'category_id')::uuid,
      note = event_row.before->>'note', version = version + 1
  where id = old_row.id
  returning * into new_row;
  update public.correction_events set undone = true where id = p_event_id;
  return new_row;
end;
$$;

revoke all on function public.correct_transaction(uuid, integer, text, text) from public;
revoke all on function public.undo_transaction_correction(uuid, integer) from public;
grant execute on function public.correct_transaction(uuid, integer, text, text) to authenticated;
grant execute on function public.undo_transaction_correction(uuid, integer) to authenticated;
