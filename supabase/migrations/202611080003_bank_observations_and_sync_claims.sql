-- The balance a bank states is its own observation, saved with the bank's date and balance type, even when
-- no new transaction arrives. balance_type is null for balances typed in or read from a statement row.
alter table public.balance_snapshots add column balance_type text check (balance_type is null or balance_type ~ '^[A-Z]{4}$');

create function public.record_bank_balance(p_connection_id uuid, p_account_name text, p_currency_code text, p_amount_minor bigint, p_as_of timestamptz, p_balance_type text) returns void
language plpgsql security definer set search_path='' as $$
declare connection public.bank_connections%rowtype; account uuid; zone text;
begin
  if p_connection_id is null or p_account_name is null or p_currency_code is null or p_amount_minor is null or p_as_of is null or p_balance_type is null then
    raise exception 'Invalid bank balance' using errcode = '22023'; end if;
  select * into connection from public.bank_connections where id = p_connection_id for update;
  if not found then raise exception 'Bank connection not found' using errcode = 'P0002'; end if;
  -- A bank sync imports into the account with the bank's name and currency; an empty account has no import to create it.
  select id into account from public.accounts where workspace_id = connection.workspace_id and name = p_account_name and currency_code = p_currency_code order by created_at limit 1;
  if account is null then
    insert into public.accounts(workspace_id, name, currency_code) values (connection.workspace_id, p_account_name, p_currency_code) returning id into account;
  end if;
  select timezone into zone from public.workspace_settings where workspace_id = connection.workspace_id;
  zone := coalesce(zone, 'Europe/Berlin');
  -- The same amount again on the same day says nothing new.
  if exists (select 1 from public.balance_snapshots where account_id = account and balance_type = p_balance_type and amount_minor = p_amount_minor and undone_at is null
    and (as_of at time zone zone)::date = (p_as_of at time zone zone)::date) then return; end if;
  insert into public.balance_snapshots(workspace_id, account_id, amount_minor, currency_code, as_of, provenance, boundary_kind, balance_type)
    values (connection.workspace_id, account, p_amount_minor, p_currency_code, p_as_of, 'bank:' || p_balance_type, 'date_only', p_balance_type);
end;
$$;
revoke all on function public.record_bank_balance(uuid, text, text, bigint, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_bank_balance(uuid, text, text, bigint, timestamptz, text) to service_role;

-- When a sync last tried, apart from when one last succeeded: a failed import never publishes last_synced_at,
-- but the background job must still wait before asking the bank again.
alter table public.bank_connections add column last_attempted_at timestamptz;
update public.bank_connections set last_attempted_at = last_synced_at;
grant select (last_attempted_at) on public.bank_connections to authenticated;

-- token_version moves whenever the sealed tokens change, so a request can tell its login was replaced before it
-- calls the login ended. The claim lets one request at a time spend the rotating refresh token.
-- portfolio_fetched_at is when the saved portfolio was read from Scalable, so an older read can't overwrite a newer one.
alter table public.scalable_connections
  add column token_version integer not null default 0,
  add column refresh_claimed_until timestamptz,
  add column portfolio_fetched_at timestamptz;

create function public.bump_scalable_token_version() returns trigger language plpgsql set search_path='' as $$
begin
  new.token_version := old.token_version + 1;
  new.refresh_claimed_until := null;
  return new;
end;
$$;
create trigger scalable_tokens_changed before update of tokens_encrypted on public.scalable_connections
  for each row when (old.tokens_encrypted is distinct from new.tokens_encrypted) execute function public.bump_scalable_token_version();

create function public.claim_scalable_refresh(p_connection_id uuid, p_token_version integer) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  update public.scalable_connections set refresh_claimed_until = now() + interval '30 seconds'
    where id = p_connection_id and status = 'active' and token_version = p_token_version and (refresh_claimed_until is null or refresh_claimed_until < now());
  return found;
end;
$$;
revoke all on function public.claim_scalable_refresh(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_scalable_refresh(uuid, integer) to service_role;

-- As before, and: rejects a read older than the saved one (returning -1), and accepts a debt, which is how a
-- negative cash balance is kept (asset amounts can't go below zero). Nothing else about the sync changes.
drop function public.sync_scalable_wealth(uuid, jsonb, jsonb);
create function public.sync_scalable_wealth(p_connection_id uuid, p_items jsonb, p_portfolio jsonb, p_fetched_at timestamptz) returns integer
language plpgsql security definer set search_path='' as $$
declare connection public.scalable_connections%rowtype; owner uuid; entry jsonb; previous public.wealth_items%rowtype; item public.wealth_items%rowtype;
  existing boolean; kept uuid[] := '{}'; changed integer := 0;
begin
  if p_connection_id is null or p_fetched_at is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_typeof(p_portfolio) is distinct from 'object' then
    raise exception 'Invalid Scalable sync' using errcode = '22023'; end if;
  select * into connection from public.scalable_connections where id = p_connection_id and status = 'active' for update;
  if not found then raise exception 'Scalable connection is not active' using errcode = 'P0002'; end if;
  if connection.portfolio_fetched_at is not null and p_fetched_at < connection.portfolio_fetched_at then return -1; end if;
  select owner_id into owner from public.workspaces where id = connection.workspace_id;
  for entry in select value from jsonb_array_elements(p_items) loop
    if entry - array['id','kind','name','currency_code','amount_minor','quantity_text','unit_price_text','cost_basis_minor','as_of','annual_rate_text','monthly_payment_minor'] <> '{}'::jsonb
      or entry->>'kind' not in ('holding','asset','debt') then raise exception 'Unsupported Scalable wealth fields' using errcode = '22023'; end if;
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
  update public.scalable_connections set portfolio = p_portfolio || jsonb_build_object('itemIds', to_jsonb(kept)), last_synced_at = now(), last_error = null, portfolio_fetched_at = p_fetched_at
    where id = p_connection_id;
  return changed;
end;
$$;
revoke all on function public.sync_scalable_wealth(uuid, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.sync_scalable_wealth(uuid, jsonb, jsonb, timestamptz) to service_role;
