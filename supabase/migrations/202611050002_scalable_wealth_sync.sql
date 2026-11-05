-- A Scalable sync writes the portfolio as wealth records (one per position, plus cash and crypto),
-- so net worth and its history use the existing valuation model. Each change is a wealth event
-- by the workspace owner, so history and undo work as for a hand-entered value.
-- portfolio keeps the latest totals, performance and synced item ids for display and removal.
alter table public.scalable_connections add column portfolio jsonb check (portfolio is null or jsonb_typeof(portfolio) = 'object');
grant select (portfolio) on public.scalable_connections to authenticated;

create function public.sync_scalable_wealth(p_connection_id uuid, p_items jsonb, p_portfolio jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare connection public.scalable_connections%rowtype; owner uuid; entry jsonb; previous public.wealth_items%rowtype; item public.wealth_items%rowtype;
  existing boolean; kept uuid[] := '{}'; changed integer := 0;
begin
  if p_connection_id is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_typeof(p_portfolio) is distinct from 'object' then
    raise exception 'Invalid Scalable sync' using errcode = '22023'; end if;
  select * into connection from public.scalable_connections where id = p_connection_id and status = 'active' for update;
  if not found then raise exception 'Scalable connection is not active' using errcode = 'P0002'; end if;
  select owner_id into owner from public.workspaces where id = connection.workspace_id;
  for entry in select value from jsonb_array_elements(p_items) loop
    if entry - array['id','kind','name','currency_code','amount_minor','quantity_text','unit_price_text','cost_basis_minor','as_of'] <> '{}'::jsonb
      or entry->>'kind' not in ('holding','asset') then raise exception 'Unsupported Scalable wealth fields' using errcode = '22023'; end if;
    item := jsonb_populate_record(null::public.wealth_items, entry);
    if item.as_of > (now() at time zone coalesce((select timezone from public.workspace_settings where workspace_id = connection.workspace_id), 'Europe/Berlin'))::date then
      raise exception 'Valuation date cannot be in the future' using errcode = '22023'; end if;
    select * into previous from public.wealth_items where id = item.id for update;
    existing := found;
    if existing and previous.workspace_id <> connection.workspace_id then raise exception 'Wealth item belongs to another workspace' using errcode = '42501'; end if;
    if existing and (previous.kind <> item.kind or previous.currency_code <> item.currency_code) then raise exception 'Scalable position changed kind or currency' using errcode = '22023'; end if;
    kept := kept || item.id;
    if existing and previous.removed_at is null and previous.name = item.name and previous.amount_minor = item.amount_minor and previous.as_of = item.as_of
      and previous.quantity_text is not distinct from item.quantity_text and previous.unit_price_text is not distinct from item.unit_price_text
      and previous.cost_basis_minor is not distinct from item.cost_basis_minor then continue; end if;
    item.workspace_id := connection.workspace_id; item.version := coalesce(previous.version, 0) + 1; item.created_at := coalesce(previous.created_at, now());
    item.updated_at := now(); item.removed_at := null;
    insert into public.wealth_items select item.* on conflict (id) do update set name = excluded.name, amount_minor = excluded.amount_minor,
      quantity_text = excluded.quantity_text, unit_price_text = excluded.unit_price_text, cost_basis_minor = excluded.cost_basis_minor, as_of = excluded.as_of,
      version = excluded.version, removed_at = null, updated_at = excluded.updated_at;
    insert into public.wealth_events(workspace_id, item_id, actor_id, request_id, before, after)
      values (connection.workspace_id, item.id, owner, gen_random_uuid(), case when existing then public.wealth_record(previous) end, public.wealth_record(item));
    changed := changed + 1;
  end loop;
  -- Positions an earlier sync (from any connection of this workspace) wrote that Scalable no longer reports were sold.
  for previous in select w.* from public.wealth_items w where w.workspace_id = connection.workspace_id and w.removed_at is null and not (w.id = any(kept))
    and w.id in (select (jsonb_array_elements_text(c.portfolio->'itemIds'))::uuid from public.scalable_connections c where c.workspace_id = connection.workspace_id and c.portfolio ? 'itemIds')
    for update loop
    item := previous; item.removed_at := now(); item.version := previous.version + 1; item.updated_at := now();
    update public.wealth_items set removed_at = item.removed_at, version = item.version, updated_at = item.updated_at where id = item.id;
    insert into public.wealth_events(workspace_id, item_id, actor_id, request_id, before, after)
      values (connection.workspace_id, item.id, owner, gen_random_uuid(), public.wealth_record(previous), public.wealth_record(item));
    changed := changed + 1;
  end loop;
  update public.scalable_connections set portfolio = p_portfolio || jsonb_build_object('itemIds', to_jsonb(kept)), last_synced_at = now(), last_error = null
    where id = p_connection_id;
  return changed;
end;
$$;
revoke all on function public.sync_scalable_wealth(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.sync_scalable_wealth(uuid, jsonb, jsonb) to service_role;
