import { availableToSpend, forecastDaily, type ForecastEvent, type ForecastInput } from "./calculations";
import { convertFx } from "./fx";
import { requireWorkspace } from "../auth";
import { loadBalanceEvidence, resolveBalances } from "./balances";
import { calendarDate } from "./calendar";

type Scheduled = { account_id: string | null; amount_minor: string; currency_code: string; cadence: string; starts_on: string; ends_on: string | null; enabled?: boolean };

export function expandSchedule(item: Scheduled, start: string, days: number): ForecastEvent[] {
  if (item.enabled === false || !item.account_id) return [];
  const first = new Date(`${item.starts_on}T00:00:00Z`);
  const horizon = new Date(`${start}T00:00:00Z`);
  const end = new Date(horizon.getTime() + days * 86400000);
  const events: ForecastEvent[] = [];
  const elapsedDays = Math.max(0, Math.floor((horizon.getTime() - first.getTime()) / 86400000));
  let firstIndex = 0;
  if (item.cadence === "daily") firstIndex = elapsedDays;
  else if (item.cadence === "weekly") firstIndex = Math.floor(elapsedDays / 7);
  else if (item.cadence === "monthly") firstIndex = Math.max(0, (horizon.getUTCFullYear() - first.getUTCFullYear()) * 12 + horizon.getUTCMonth() - first.getUTCMonth() - 1);
  else if (item.cadence === "yearly") firstIndex = Math.max(0, horizon.getUTCFullYear() - first.getUTCFullYear() - 1);
  const startMonth = first.getUTCMonth();
  const startDate = first.getUTCDate();
  for (let n = firstIndex; n < firstIndex + days + 2; n++) {
    const date = new Date(first);
    if (item.cadence === "once" && n > 0) break;
    if (item.cadence === "daily") date.setUTCDate(first.getUTCDate() + n);
    else if (item.cadence === "weekly") date.setUTCDate(first.getUTCDate() + 7 * n);
    else if (item.cadence === "monthly") {
      date.setUTCDate(1);
      date.setUTCMonth(first.getUTCMonth() + n);
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(startDate, lastDay));
    } else if (item.cadence === "yearly") {
      const targetYear = first.getUTCFullYear() + n;
      const lastDay = new Date(Date.UTC(targetYear, startMonth + 1, 0)).getUTCDate();
      date.setUTCFullYear(targetYear);
      date.setUTCMonth(startMonth);
      date.setUTCDate(Math.min(startDate, lastDay));
    } else if (item.cadence !== "once") throw new Error(`Unknown cadence: ${item.cadence}`);
    if (date >= end || (item.ends_on && date.toISOString().slice(0, 10) > item.ends_on)) break;
    if (date < horizon) continue;
    const amount = BigInt(item.amount_minor);
    events.push({ date: date.toISOString().slice(0, 10), accountId: item.account_id,
      expectedMinor: amount,
      conservativeMinor: amount > 0n ? amount * 9n / 10n : amount * 11n / 10n,
      optimisticMinor: amount > 0n ? amount * 11n / 10n : amount * 9n / 10n });
  }
  return events;
}

export async function evaluatePlan(horizonDays = 30, scenarioId?: string) {
  const { supabase, workspace } = await requireWorkspace();
  const [balanceEvidence,
    { data: allocations, error: allocationsError }, { data: assumptions, error: assumptionsError },
    { data: rates, error: ratesError }] = await Promise.all([
      loadBalanceEvidence(supabase, workspace.id),
      supabase.from("goal_allocations").select("account_id, amount_minor::text").eq("workspace_id", workspace.id),
      supabase.from("financial_assumptions").select("account_id, amount_minor::text, currency_code, cadence, starts_on, ends_on, enabled")
        .eq("workspace_id", workspace.id).eq("enabled", true).eq("confirmed", true),
      supabase.from("fx_rates").select("from_currency, to_currency, rate_text, rate_date, source")
        .eq("workspace_id", workspace.id).eq("to_currency", workspace.display_currency),
    ]);
  for (const error of [allocationsError, assumptionsError, ratesError]) if (error) throw error;
  const convert = (amount: bigint, from: string, date: string) => {
    const rate = (rates ?? []).filter(row => row.from_currency === from && row.rate_date <= date)
      .sort((a, b) => b.rate_date.localeCompare(a.rate_date))[0];
    const result = convertFx({ amountMinor: amount, from, to: workspace.display_currency,
      rate: rate?.rate_text, source: rate?.source ?? "forecast", date: rate?.rate_date ?? date });
    return result.status === "available" ? result.converted.amountMinor : null;
  };
  const reserved = new Map<string, bigint>();
  for (const allocation of allocations ?? []) reserved.set(allocation.account_id, (reserved.get(allocation.account_id) ?? 0n) + BigInt(allocation.amount_minor));
  const spendable = resolveBalances(balanceEvidence.accounts, balanceEvidence.snapshots, balanceEvidence.ledger, balanceEvidence.asOf, workspace.timezone)
    .filter(account => ["checking", "savings", "cash", "wallet"].includes(account.type ?? ""));
  const startDate = calendarDate(balanceEvidence.asOf, workspace.timezone);
  const accountIds = new Set(spendable.map(account => account.id));
  const missingInputs = (assumptions ?? []).flatMap(item =>
    !item.account_id || !accountIds.has(item.account_id) ? [`assumption account`] :
      []);
  const events = (assumptions ?? []).filter(item => item.account_id && accountIds.has(item.account_id)).flatMap(item =>
    expandSchedule(item, startDate, horizonDays).flatMap(event => {
      const cv = (amount: bigint) => convert(amount, item.currency_code, event.date);
      const expectedMinor = cv(event.expectedMinor), conservativeMinor = cv(event.conservativeMinor!), optimisticMinor = cv(event.optimisticMinor!);
      if (expectedMinor === null || conservativeMinor === null || optimisticMinor === null) { missingInputs.push(`fx:assumption:${item.account_id}`); return []; }
      return [{ ...event, expectedMinor, conservativeMinor, optimisticMinor }];
    }));
  let scenarioEvents: ForecastEvent[] = [];
  if (scenarioId) {
    const { data: scenario } = await supabase.from("scenarios").select("id").eq("workspace_id", workspace.id).eq("id", scenarioId).maybeSingle();
    if (!scenario) throw new Error("Scenario not found");
    const { data: overrides, error } = await supabase.from("scenario_overrides")
      .select("id, account_id, amount_delta_minor::text, currency_code, cadence, starts_on, ends_on")
      .eq("workspace_id", workspace.id).eq("scenario_id", scenarioId);
    if (error) throw error;
    missingInputs.push(...(overrides ?? []).flatMap(item => !item.account_id || !accountIds.has(item.account_id) ? ["scenario account"] : []));
    scenarioEvents = (overrides ?? []).flatMap(item => item.account_id && accountIds.has(item.account_id)
      ? expandSchedule({ ...item, amount_minor: item.amount_delta_minor }, startDate, horizonDays).flatMap(event => {
        const cv = (amount: bigint) => convert(amount, item.currency_code, event.date);
        const expectedMinor = cv(event.expectedMinor), conservativeMinor = cv(event.conservativeMinor!), optimisticMinor = cv(event.optimisticMinor!);
        if (expectedMinor === null || conservativeMinor === null || optimisticMinor === null) { missingInputs.push(`fx:scenario:${item.id}`); return []; }
        return [{ ...event, expectedMinor, conservativeMinor, optimisticMinor }];
      }) : []);
  }
  const input: ForecastInput = {
    startDate, horizonDays, currencyCode: workspace.display_currency,
    accounts: spendable.map(account => {
      const snapshot = account.balance;
      const balanceMinor = snapshot.amount_minor !== null ? convert(BigInt(snapshot.amount_minor), snapshot.currency_code, startDate) : null;
      const reservedMinor = convert(reserved.get(account.id) ?? 0n, account.currency_code, startDate);
      if (snapshot.status !== "current") missingInputs.push(`balance:${account.id}:${snapshot.status}`);
      else if (balanceMinor === null) missingInputs.push(`fx:balance:${account.id}`);
      if (reservedMinor === null) missingInputs.push(`fx:allocation:${account.id}`);
      let pendingHoldMinor = 0n;
      for (const row of balanceEvidence.ledger) {
        if (row.account_id !== account.id || row.status !== "pending" || row.posted_on > startDate || BigInt(row.amount_minor) >= 0n) continue;
        const hold = convert(-BigInt(row.amount_minor), row.currency_code, startDate);
        if (hold === null) missingInputs.push(`fx:pending:${account.id}`);
        else pendingHoldMinor += hold;
      }
      return { id: account.id, currencyCode: workspace.display_currency, balanceMinor,
        pendingHoldMinor,
        reservedMinor: reservedMinor ?? 0n };
    }),
    events, scenarioEvents, missingInputs,
  };
  const forecast = forecastDaily(input);
  const available = availableToSpend(input);
  return { forecast, available, input };
}
