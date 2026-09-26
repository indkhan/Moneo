-- Plan assumption user controls (prompt.md §15).
--
-- Plan → Financial Model now lets the user edit, enable/disable, or remove
-- each financial_assumptions row. Edits set source = 'user' and
-- confirmed = true so a user-confirmed value takes priority over later
-- inferred recurring updates.
--
-- Why this migration exists (see 008):
-- * 013 granted only select + insert on financial_assumptions, so direct
--   user edits would fail. Grant update + delete; the existing
--   own_financial_assumptions RLS policy (workspace + same-workspace
--   account) already scopes every row.
-- * recurring_series.assumption_id had no ON DELETE action, so removing a
--   confirmed recurring assumption failed or left a dangling link. Use
--   ON DELETE SET NULL plus a before-delete trigger that clears the link
--   and marks the series dismissed, so a deleted assumption is not shown
--   as confirmed and is never silently resurrected in the forecast.
-- * confirm_recurring_series unconditionally overwrote the linked
--   assumption (including enabled = true). A detection retry after the
--   user edited or disabled the assumption in Plan would silently undo the
--   user's choice. The replacement below preserves any linked assumption
--   with source = 'user' and only refreshes series evidence.

grant update, delete on public.financial_assumptions to authenticated;

alter table public.recurring_series drop constraint if exists recurring_series_assumption_id_fkey;
alter table public.recurring_series add constraint recurring_series_assumption_id_fkey
  foreign key (assumption_id) references public.financial_assumptions(id) on delete set null;

create or replace function public.dismiss_series_on_assumption_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.recurring_series set assumption_id = null, status = 'dismissed'
  where assumption_id = old.id and workspace_id = old.workspace_id;
  return old;
end;
$$;

revoke all on function public.dismiss_series_on_assumption_delete() from public;

drop trigger if exists dismiss_series_on_assumption_delete on public.financial_assumptions;
create trigger dismiss_series_on_assumption_delete
before delete on public.financial_assumptions
for each row execute function public.dismiss_series_on_assumption_delete();

-- Same signature and validation as 008; only the assumption-write branch
-- changes: a linked assumption with source = 'user' is left untouched.
create or replace function public.confirm_recurring_series(
  p_account_id uuid,
  p_label text,
  p_cadence text,
  p_currency_code text,
  p_amount_min_minor bigint,
  p_amount_max_minor bigint,
  p_occurrences integer,
  p_confidence integer,
  p_transaction_ids uuid[]
) returns public.recurring_series
language plpgsql security definer set search_path = '' as $$
declare
  account_row public.accounts%rowtype;
  clean_label text := btrim(p_label);
  normalized text;
  series_row public.recurring_series%rowtype;
  evidence_count integer;
  evidence_min bigint;
  evidence_max bigint;
  latest_amount bigint;
  latest_date date;
  assumption_row public.financial_assumptions%rowtype;
  assumption_kind text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if clean_label is null or length(clean_label) < 1 or length(clean_label) > 200 then
    raise exception 'Invalid series label' using errcode = '22023';
  end if;
  normalized := lower(regexp_replace(clean_label, '\s+', ' ', 'g'));
  if p_cadence not in ('weekly', 'monthly') then
    raise exception 'Invalid cadence' using errcode = '22023';
  end if;
  if p_currency_code is null or p_currency_code !~ '^[A-Z]{3}$' then
    raise exception 'Invalid currency' using errcode = '22023';
  end if;
  if p_amount_min_minor is null or p_amount_max_minor is null or p_amount_min_minor > p_amount_max_minor then
    raise exception 'Invalid amount range' using errcode = '22023';
  end if;
  if p_occurrences is null or p_occurrences < 3 then
    raise exception 'Series needs at least 3 occurrences' using errcode = '22023';
  end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 100 then
    raise exception 'Invalid confidence' using errcode = '22023';
  end if;
  if p_transaction_ids is null or coalesce(array_length(p_transaction_ids, 1), 0) < 3
    or coalesce(array_length(p_transaction_ids, 1), 0) > 1000 then
    raise exception 'Evidence must list 3 to 1000 transactions' using errcode = '22023';
  end if;
  if p_occurrences <> array_length(p_transaction_ids, 1) then
    raise exception 'Occurrences must match evidence count' using errcode = '22023';
  end if;

  select * into account_row from public.accounts
  where id = p_account_id and public.owns_workspace(workspace_id)
  for update;
  if not found then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  if account_row.currency_code <> p_currency_code then
    raise exception 'Series currency must match account currency' using errcode = '22023';
  end if;

  select count(*), max(posted_on), min(amount_minor), max(amount_minor)
  into evidence_count, latest_date, evidence_min, evidence_max
  from public.transactions
  where id = any (p_transaction_ids)
    and workspace_id = account_row.workspace_id
    and account_id = p_account_id
    and status = 'posted'
    and kind = 'ordinary'
    and currency_code = p_currency_code;
  if evidence_count <> array_length(p_transaction_ids, 1) then
    raise exception 'Evidence transactions not found' using errcode = 'P0002';
  end if;
  if evidence_min <> p_amount_min_minor or evidence_max <> p_amount_max_minor then
    raise exception 'Evidence amount range changed' using errcode = '22023';
  end if;

  select amount_minor into latest_amount from public.transactions
  where id = any (p_transaction_ids)
    and workspace_id = account_row.workspace_id
    and account_id = p_account_id
  order by posted_on desc, id desc limit 1;

  insert into public.recurring_series
    (workspace_id, account_id, label, normalized_label, cadence, currency_code,
     amount_min_minor, amount_max_minor, occurrences, confidence, status)
  values
    (account_row.workspace_id, p_account_id, clean_label, normalized, p_cadence, p_currency_code,
     p_amount_min_minor, p_amount_max_minor, p_occurrences, p_confidence, 'confirmed')
  on conflict (workspace_id, account_id, normalized_label, cadence, currency_code)
  do update set label = excluded.label,
    amount_min_minor = excluded.amount_min_minor,
    amount_max_minor = excluded.amount_max_minor,
    occurrences = excluded.occurrences,
    confidence = excluded.confidence,
    status = 'confirmed'
  returning * into series_row;

  if series_row.assumption_id is not null then
    select * into assumption_row from public.financial_assumptions
    where id = series_row.assumption_id and workspace_id = account_row.workspace_id
    for update;
  end if;
  assumption_kind := case when latest_amount >= 0 then 'income' else 'expense' end;
  if assumption_row.id is not null and assumption_row.source = 'user' then
    -- User-confirmed edit, disable, or re-enable in Plan wins over this
    -- inferred retry. Keep the user's amount, cadence, dates, and enabled
    -- flag; only series evidence above is refreshed.
    null;
  elsif assumption_row.id is not null then
    update public.financial_assumptions set
      account_id = p_account_id, kind = assumption_kind, name = clean_label,
      amount_minor = latest_amount, currency_code = p_currency_code,
      cadence = p_cadence, starts_on = latest_date,
      source = 'recurring_confirmed', confidence = p_confidence,
      confirmed = true, enabled = true
    where id = assumption_row.id
    returning * into assumption_row;
  else
    insert into public.financial_assumptions
      (workspace_id, account_id, kind, name, amount_minor, currency_code,
       cadence, starts_on, source, confidence, confirmed, enabled)
    values
      (account_row.workspace_id, p_account_id, assumption_kind, clean_label, latest_amount, p_currency_code,
       p_cadence, latest_date, 'recurring_confirmed', p_confidence, true, true)
    returning * into assumption_row;
    update public.recurring_series set assumption_id = assumption_row.id
    where id = series_row.id;
    series_row.assumption_id := assumption_row.id;
  end if;

  delete from public.recurring_series_transactions
  where series_id = series_row.id and workspace_id = account_row.workspace_id;
  insert into public.recurring_series_transactions (series_id, transaction_id, workspace_id)
  select series_row.id, t.id, account_row.workspace_id
  from unnest(p_transaction_ids) as t(id)
  on conflict (series_id, transaction_id) do nothing;

  select * into series_row from public.recurring_series where id = series_row.id;
  return series_row;
end;
$$;

revoke all on function public.confirm_recurring_series(uuid, text, text, text, bigint, bigint, integer, integer, uuid[]) from public;
grant execute on function public.confirm_recurring_series(uuid, text, text, text, bigint, bigint, integer, integer, uuid[]) to authenticated;
