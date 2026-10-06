-- Explicit occurrence associations are independent of historical pattern evidence.
create table public.recurring_occurrence_settlements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  -- Historical entity IDs deliberately survive canonical delete/undo; RPC verifies owned targets.
  assumption_id uuid not null,
  scheduled_on date not null,
  transaction_id uuid not null,
  completes_occurrence boolean not null,
  receipt jsonb not null check(jsonb_typeof(receipt)='object'),
  actor_id uuid not null references auth.users(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
create unique index recurring_occurrence_active_transaction on public.recurring_occurrence_settlements(transaction_id) where undone_at is null;
create index recurring_occurrence_workspace on public.recurring_occurrence_settlements(workspace_id, assumption_id, scheduled_on);
alter table public.recurring_occurrence_settlements enable row level security;
create policy recurring_occurrence_read on public.recurring_occurrence_settlements for select to authenticated using(public.owns_workspace(workspace_id));
grant select on public.recurring_occurrence_settlements to authenticated;
revoke insert,update,delete on public.recurring_occurrence_settlements from authenticated;

create function public.record_recurring_occurrence(p_assumption_id uuid, p_assumption_version integer, p_scheduled_on date,
  p_transaction_id uuid, p_transaction_version integer, p_completes_occurrence boolean)
returns public.recurring_occurrence_settlements language plpgsql security definer set search_path='' as $$
declare a public.financial_assumptions%rowtype; t public.transactions%rowtype; result public.recurring_occurrence_settlements%rowtype;
  month_distance integer; expected_date date;
begin
  select * into a from public.financial_assumptions where id=p_assumption_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Assumption not found' using errcode='P0002'; end if;
  if p_assumption_version is null or a.version<>p_assumption_version then raise exception 'Assumption changed; reload before associating' using errcode='40001'; end if;
  if not a.confirmed or not a.enabled or a.removed_at is not null or a.account_id is null or a.amount_minor=0 or a.cadence not in ('weekly','monthly') then
    raise exception 'Choose an active confirmed recurring assumption' using errcode='22023';
  end if;
  if p_scheduled_on is null or p_scheduled_on<a.starts_on or (a.ends_on is not null and p_scheduled_on>a.ends_on) then raise exception 'Invalid occurrence date' using errcode='22023'; end if;
  if a.cadence='weekly' then
    if (p_scheduled_on-a.starts_on)%7<>0 then raise exception 'Date is not a scheduled occurrence' using errcode='22023'; end if;
  else
    month_distance:=(extract(year from p_scheduled_on)::integer-extract(year from a.starts_on)::integer)*12+extract(month from p_scheduled_on)::integer-extract(month from a.starts_on)::integer;
    expected_date:=(a.starts_on+make_interval(months=>month_distance))::date;
    if expected_date<>p_scheduled_on then raise exception 'Date is not a scheduled occurrence' using errcode='22023'; end if;
  end if;
  select * into t from public.transactions where id=p_transaction_id and workspace_id=a.workspace_id for update;
  if not found then raise exception 'Transaction not found' using errcode='P0002'; end if;
  if p_transaction_version is null or t.version<>p_transaction_version then raise exception 'Transaction changed; reload before associating' using errcode='40001'; end if;
  if t.account_id<>a.account_id or t.currency_code<>a.currency_code or t.status not in ('pending','posted') or t.kind<>'ordinary' or cardinality(t.review_reasons)<>0 or t.amount_minor=0 or sign(t.amount_minor)<>sign(a.amount_minor) or p_completes_occurrence is null then
    raise exception 'Transaction does not fit this obligation' using errcode='22023';
  end if;
  insert into public.recurring_occurrence_settlements(workspace_id,assumption_id,scheduled_on,transaction_id,completes_occurrence,receipt,actor_id)
  values(a.workspace_id,a.id,p_scheduled_on,t.id,p_completes_occurrence,jsonb_build_object('account_id',t.account_id,'amount_minor',t.amount_minor::text,'currency_code',t.currency_code,'kind',t.kind,'review_reasons',t.review_reasons),auth.uid()) returning * into result;
  return result;
end;
$$;
create function public.undo_recurring_occurrence(p_settlement_id uuid,p_version integer)
returns public.recurring_occurrence_settlements language plpgsql security definer set search_path='' as $$
declare r public.recurring_occurrence_settlements%rowtype;
begin
  select * into r from public.recurring_occurrence_settlements where id=p_settlement_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Association not found' using errcode='P0002'; end if;
  if p_version is null or r.version<>p_version or r.undone_at is not null then raise exception 'Association changed; reload before undo' using errcode='40001'; end if;
  -- Retain the original financial receipt and actor; only the reversible association is retired.
  update public.recurring_occurrence_settlements set undone_at=now(),version=version+1 where id=r.id returning * into r;
  return r;
end;
$$;
revoke all on function public.record_recurring_occurrence(uuid,integer,date,uuid,integer,boolean),public.undo_recurring_occurrence(uuid,integer) from public,anon;
grant execute on function public.record_recurring_occurrence(uuid,integer,date,uuid,integer,boolean),public.undo_recurring_occurrence(uuid,integer) to authenticated;
