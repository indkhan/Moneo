-- Minimal multi-currency display support.
--
-- Original transactions, accounts and balance snapshots are never rewritten
-- when the workspace display currency changes. Conversions are derived at
-- read time from these dated manual rates via lib/finance/fx.ts convertFx().
-- Rates are directional (from_currency -> to_currency); same-currency
-- amounts need no rate. Home uses the most recent rate on/before each
-- balance as-of date. Missing balances or rates must surface as
-- unavailable/partial, never as zero.

create table public.fx_rates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  from_currency text not null check (from_currency ~ '^[A-Z]{3}$'),
  to_currency text not null check (to_currency ~ '^[A-Z]{3}$'),
  rate_text text not null check (char_length(rate_text) <= 40 and rate_text ~ '^[0-9]+(\.[0-9]+)?$'),
  rate_date date not null,
  source text not null check (char_length(source) between 1 and 120),
  created_at timestamptz not null default now(),
  constraint fx_rates_different_currencies check (from_currency <> to_currency),
  constraint fx_rates_positive_rate check (rate_text::numeric > 0),
  constraint fx_rates_workspace_pair_date_unique unique (workspace_id, from_currency, to_currency, rate_date)
);

create index fx_rates_workspace_pair_date_idx
  on public.fx_rates (workspace_id, from_currency, to_currency, rate_date desc);

alter table public.fx_rates enable row level security;

create policy own_fx_rates on public.fx_rates for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id));
