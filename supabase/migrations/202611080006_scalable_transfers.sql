-- Money Scalable itself says moved in or out of the broker, once per transfer by Scalable's own ID. A returned withdrawal
-- is linked to its return (RETURN-<withdrawal id>), and neither is ever deleted: read-time rules decide how charts show them.
-- A disconnect keeps these rows, as it keeps synced values; reset clears them with the workspace.
create table public.scalable_transfers (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_id text not null check (char_length(provider_id) between 1 and 200),
  type text not null check (type in ('DEPOSIT','WITHDRAWAL')),
  amount_minor bigint not null check (amount_minor <> 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  on_date date not null,
  status text not null check (char_length(status) between 1 and 40),
  is_cancellation boolean not null default false,
  description text check (char_length(description) <= 500),
  returns_provider_id text check (char_length(returns_provider_id) <= 200),
  revision integer not null default 1,
  revisions jsonb not null default '[]' check (jsonb_typeof(revisions) = 'array'),
  first_seen_at timestamptz not null default now(),
  primary key (workspace_id, provider_id)
);
create index scalable_transfers_date on public.scalable_transfers(workspace_id, on_date);
alter table public.scalable_transfers enable row level security;
create policy scalable_transfers_owner_select on public.scalable_transfers for select to authenticated using (public.owns_workspace(workspace_id));
revoke all on public.scalable_transfers from public, anon, authenticated;
grant select on public.scalable_transfers to authenticated;
grant all on public.scalable_transfers to service_role;

-- When the whole list was read. Until then recent syncs may hold only part of the history, so a bank row without a broker side isn't called unresolved.
alter table public.scalable_connections add column transfers_backfilled_at timestamptz;
grant select (transfers_backfilled_at) on public.scalable_connections to authenticated;

create function public.save_scalable_transfers(p_connection_id uuid, p_rows jsonb, p_complete boolean) returns integer
language plpgsql security definer set search_path='' as $$
declare connection public.scalable_connections%rowtype; entry jsonb; prior public.scalable_transfers%rowtype; changed integer := 0;
begin
  if p_connection_id is null or p_complete is null or jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'Invalid Scalable transfers' using errcode = '22023'; end if;
  select * into connection from public.scalable_connections where id = p_connection_id and status = 'active' for update;
  if not found then raise exception 'Scalable connection is not active' using errcode = 'P0002'; end if;
  for entry in select value from jsonb_array_elements(p_rows) loop
    select * into prior from public.scalable_transfers where workspace_id = connection.workspace_id and provider_id = entry->>'provider_id' for update;
    if not found then
      insert into public.scalable_transfers(workspace_id, provider_id, type, amount_minor, currency_code, occurred_at, on_date, status, is_cancellation, description, returns_provider_id)
        values (connection.workspace_id, entry->>'provider_id', entry->>'type', (entry->>'amount_minor')::bigint, entry->>'currency_code', (entry->>'occurred_at')::timestamptz, (entry->>'on_date')::date,
          entry->>'status', coalesce((entry->>'is_cancellation')::boolean, false), entry->>'description', entry->>'returns_provider_id');
      changed := changed + 1;
    elsif (prior.type, prior.amount_minor, prior.currency_code, prior.occurred_at, prior.on_date, prior.status, prior.is_cancellation, prior.description) is distinct from
      (entry->>'type', (entry->>'amount_minor')::bigint, entry->>'currency_code', (entry->>'occurred_at')::timestamptz, (entry->>'on_date')::date, entry->>'status', coalesce((entry->>'is_cancellation')::boolean, false), entry->>'description') then
      -- Scalable revised it: the earlier state stays on the row.
      update public.scalable_transfers set type = entry->>'type', amount_minor = (entry->>'amount_minor')::bigint, currency_code = entry->>'currency_code', occurred_at = (entry->>'occurred_at')::timestamptz,
        on_date = (entry->>'on_date')::date, status = entry->>'status', is_cancellation = coalesce((entry->>'is_cancellation')::boolean, false), description = entry->>'description', revision = prior.revision + 1,
        revisions = prior.revisions || jsonb_build_array(to_jsonb(prior) - array['workspace_id','revisions','first_seen_at'])
        where workspace_id = connection.workspace_id and provider_id = prior.provider_id;
      changed := changed + 1;
    end if;
  end loop;
  if p_complete then update public.scalable_connections set transfers_backfilled_at = now() where id = connection.id; end if;
  return changed;
end;
$$;
revoke all on function public.save_scalable_transfers(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.save_scalable_transfers(uuid, jsonb, boolean) to service_role;
