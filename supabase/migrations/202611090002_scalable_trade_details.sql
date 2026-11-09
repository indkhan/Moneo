-- What each Scalable trade's details say that its list row doesn't: the ETP behind a crypto row, and the price paid without
-- fees. A trade's details never change, so this keeps the daily calculation from asking about every trade on every run. Facts
-- about past trades, so a disconnect keeps them; reset all data removes them with the workspace.
create table public.scalable_trade_details (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_id text not null,
  isin text not null,
  price_text text check (price_text ~ '^[0-9]+(\.[0-9]+)?$'),
  primary key (workspace_id, provider_id)
);
alter table public.scalable_trade_details enable row level security;
revoke all on public.scalable_trade_details from public, anon, authenticated;
grant all on public.scalable_trade_details to service_role;
