-- The price chart of each Scalable position as of the last sync, and the owner's own settled buys and sells of it, so the
-- Wealth detail opens with no call to Scalable. Prices are decimal text. A disconnect removes both tables' rows for the
-- workspace; reset all data removes them with the workspace.
create table public.scalable_security_charts (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  isin text not null check (isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  timeframe text not null check (timeframe in ('one_day','seven_days','one_month','one_year','max')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  points jsonb not null check (jsonb_typeof(points) = 'array'),
  fetched_at timestamptz not null,
  primary key (workspace_id, isin, timeframe)
);
alter table public.scalable_security_charts enable row level security;
create policy scalable_security_charts_owner_select on public.scalable_security_charts for select to authenticated using (public.owns_workspace(workspace_id));
revoke all on public.scalable_security_charts from public, anon, authenticated;
grant select on public.scalable_security_charts to authenticated;
grant all on public.scalable_security_charts to service_role;

create table public.scalable_security_trades (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_id text not null check (char_length(provider_id) between 1 and 200),
  isin text not null check (isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  side text not null check (side in ('BUY','SELL')),
  occurred_at timestamptz not null,
  quantity_text text not null check (quantity_text ~ '^[0-9]+(\.[0-9]+)?$'),
  primary key (workspace_id, provider_id)
);
create index scalable_security_trades_isin on public.scalable_security_trades(workspace_id, isin, occurred_at);
alter table public.scalable_security_trades enable row level security;
create policy scalable_security_trades_owner_select on public.scalable_security_trades for select to authenticated using (public.owns_workspace(workspace_id));
revoke all on public.scalable_security_trades from public, anon, authenticated;
grant select on public.scalable_security_trades to authenticated;
grant all on public.scalable_security_trades to service_role;

create function public.save_scalable_charts(p_connection_id uuid, p_charts jsonb, p_trades jsonb, p_held text[]) returns void
language plpgsql security definer set search_path='' as $$
declare connection public.scalable_connections%rowtype;
begin
  if p_connection_id is null or jsonb_typeof(p_charts) is distinct from 'array' or jsonb_typeof(p_trades) is distinct from 'array' then
    raise exception 'Invalid Scalable charts' using errcode = '22023'; end if;
  select * into connection from public.scalable_connections where id = p_connection_id and status = 'active' for update;
  if not found then raise exception 'Scalable connection is not active' using errcode = 'P0002'; end if;
  insert into public.scalable_security_charts(workspace_id, isin, timeframe, currency_code, points, fetched_at)
    select connection.workspace_id, chart.isin, chart.timeframe, chart.currency_code, chart.points, chart.fetched_at
    from jsonb_to_recordset(p_charts) as chart(isin text, timeframe text, currency_code text, points jsonb, fetched_at timestamptz)
    on conflict (workspace_id, isin, timeframe) do update set currency_code = excluded.currency_code, points = excluded.points, fetched_at = excluded.fetched_at;
  insert into public.scalable_security_trades(workspace_id, provider_id, isin, side, occurred_at, quantity_text)
    select connection.workspace_id, trade.provider_id, trade.isin, trade.side, trade.occurred_at, trade.quantity_text
    from jsonb_to_recordset(p_trades) as trade(provider_id text, isin text, side text, occurred_at timestamptz, quantity_text text)
    on conflict (workspace_id, provider_id) do update set isin = excluded.isin, side = excluded.side, occurred_at = excluded.occurred_at, quantity_text = excluded.quantity_text;
  if p_held is not null then
    delete from public.scalable_security_charts where workspace_id = connection.workspace_id and isin <> all(p_held);
  end if;
end;
$$;
revoke all on function public.save_scalable_charts(uuid, jsonb, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.save_scalable_charts(uuid, jsonb, jsonb, text[]) to service_role;

create function public.remove_scalable_charts(p_workspace_id uuid) returns void
language sql security definer set search_path='' as $$
  delete from public.scalable_security_trades where workspace_id = p_workspace_id;
  delete from public.scalable_security_charts where workspace_id = p_workspace_id;
$$;
revoke all on function public.remove_scalable_charts(uuid) from public, anon, authenticated;
grant execute on function public.remove_scalable_charts(uuid) to service_role;
