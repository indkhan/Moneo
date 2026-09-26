create table public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null,
  target_minor bigint not null check (target_minor > 0),
  currency_code text not null,
  target_date date,
  priority integer not null default 0,
  status text not null default 'active',
  notes text,
  version integer not null default 0,
  idempotency_key text,
  created_at timestamptz not null default now(),
  constraint goals_workspace_idempotency_unique unique (workspace_id, idempotency_key)
);

create table public.goal_allocations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  goal_id uuid not null references public.goals(id),
  account_id uuid not null references public.accounts(id),
  amount_minor bigint not null check (amount_minor > 0),
  constraint goal_allocations_goal_account_unique unique (goal_id, account_id)
);

create table public.financial_assumptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  account_id uuid references public.accounts(id),
  kind text not null,
  name text not null,
  amount_minor bigint not null,
  currency_code text not null,
  cadence text not null check (cadence in ('once', 'daily', 'weekly', 'monthly', 'yearly')),
  starts_on date not null,
  ends_on date,
  source text not null,
  confidence integer check (confidence between 0 and 100),
  confirmed boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint financial_assumptions_dates check (ends_on is null or ends_on >= starts_on)
);

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table public.scenario_overrides (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  scenario_id uuid not null references public.scenarios(id),
  account_id uuid not null references public.accounts(id),
  assumption_id uuid references public.financial_assumptions(id),
  name text not null,
  amount_delta_minor bigint not null,
  currency_code text not null,
  cadence text not null check (cadence in ('once', 'daily', 'weekly', 'monthly', 'yearly')),
  starts_on date not null,
  ends_on date,
  constraint scenario_overrides_dates check (ends_on is null or ends_on >= starts_on)
);

create table public.forecast_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  scenario_id uuid references public.scenarios(id),
  horizon_start date not null,
  horizon_end date not null,
  inputs jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint forecast_runs_dates check (horizon_end >= horizon_start)
);

alter table public.goals enable row level security;
alter table public.goal_allocations enable row level security;
alter table public.financial_assumptions enable row level security;
alter table public.scenarios enable row level security;
alter table public.scenario_overrides enable row level security;
alter table public.forecast_runs enable row level security;

create policy own_goals on public.goals for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id));

create policy own_goal_allocations on public.goal_allocations for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id)
  and exists (select 1 from public.goals where id = goal_id and workspace_id = goal_allocations.workspace_id)
  and exists (select 1 from public.accounts where id = account_id and workspace_id = goal_allocations.workspace_id));

create policy own_financial_assumptions on public.financial_assumptions for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and (account_id is null or exists (
  select 1 from public.accounts where id = account_id and workspace_id = financial_assumptions.workspace_id
)));

create policy own_scenarios on public.scenarios for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id));

create policy own_scenario_overrides on public.scenario_overrides for all to authenticated
using (public.owns_workspace(workspace_id)
  and exists (select 1 from public.scenarios where id = scenario_id and workspace_id = scenario_overrides.workspace_id))
with check (public.owns_workspace(workspace_id)
  and exists (select 1 from public.scenarios where id = scenario_id and workspace_id = scenario_overrides.workspace_id)
  and exists (select 1 from public.accounts where id = account_id and workspace_id = scenario_overrides.workspace_id)
  and (assumption_id is null or exists (select 1 from public.financial_assumptions
    where id = assumption_id and workspace_id = scenario_overrides.workspace_id
      and (account_id is null or account_id = scenario_overrides.account_id))));

create policy own_forecast_runs on public.forecast_runs for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and (scenario_id is null or exists (
  select 1 from public.scenarios where id = scenario_id and workspace_id = forecast_runs.workspace_id
)));

-- Reservations are serialized per account. A missing dated balance cannot fund a reservation.
revoke insert, update, delete on public.goal_allocations from public, authenticated;

create function public.set_goal_allocation(
  p_goal_id uuid,
  p_account_id uuid,
  p_amount_minor bigint
) returns public.goal_allocations
language plpgsql security definer set search_path = '' as $$
declare
  account_row public.accounts%rowtype;
  allocation_row public.goal_allocations%rowtype;
  available_minor bigint;
  balance_currency text;
  reserved_minor bigint;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_amount_minor is null or p_amount_minor < 0 then
    raise exception 'Allocation must be nonnegative' using errcode = '22003';
  end if;

  select * into account_row from public.accounts
  where id = p_account_id and public.owns_workspace(workspace_id)
  for update;
  if not found or not exists (select 1 from public.goals
    where id = p_goal_id and workspace_id = account_row.workspace_id) then
    raise exception 'Goal or account not found' using errcode = 'P0002';
  end if;

  if p_amount_minor = 0 then
    delete from public.goal_allocations where goal_id = p_goal_id and account_id = p_account_id;
    return null;
  end if;

  select amount_minor, currency_code into available_minor, balance_currency from public.balance_snapshots
  where account_id = p_account_id and workspace_id = account_row.workspace_id
    and as_of <= now()
  order by as_of desc, created_at desc, id desc limit 1;
  if available_minor is null or balance_currency <> account_row.currency_code then
    raise exception 'A dated account balance is required before reserving cash' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount_minor), 0) into reserved_minor from public.goal_allocations
  where account_id = p_account_id and goal_id <> p_goal_id;
  if p_amount_minor > available_minor - reserved_minor then
    raise exception 'Allocation exceeds unreserved account balance' using errcode = '22003';
  end if;

  insert into public.goal_allocations (workspace_id, goal_id, account_id, amount_minor)
  values (account_row.workspace_id, p_goal_id, p_account_id, p_amount_minor)
  on conflict (goal_id, account_id) do update set amount_minor = excluded.amount_minor
  returning * into allocation_row;
  return allocation_row;
end;
$$;

revoke all on function public.set_goal_allocation(uuid, uuid, bigint) from public;
grant execute on function public.set_goal_allocation(uuid, uuid, bigint) to authenticated;
