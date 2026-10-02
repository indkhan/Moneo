import { availableToSpend, forecastDaily, type ForecastEvent, type ForecastInput } from "./calculations";
import { convertFx } from "./fx";
import { requireWorkspace } from "../auth";
import { loadBalanceEvidence, resolveBalances } from "./balances";
import { calendarDate } from "./calendar";
import { buildDebtForecast, loadWealthItems } from "./wealth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultForecastPreferences, forecastCases, forecastPreferencesSchema } from "./preferences";

type Scheduled = { account_id: string | null; amount_minor: string; currency_code: string; cadence: string; starts_on: string; ends_on: string | null; enabled?: boolean };

export function expandSchedule(item: Scheduled, start: string, days: number, uncertaintyBps = 1000): ForecastEvent[] {
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
      ...forecastCases(amount, uncertaintyBps) });
  }
  return events;
}

export async function evaluatePlan(horizonDays = 30, scenarioId?: string) {
  const { supabase, workspace } = await requireWorkspace();
  return evaluatePlanForWorkspace(supabase, workspace, horizonDays, scenarioId);
}

export async function evaluatePlanForWorkspace(supabase: SupabaseClient, workspace: { id: string; display_currency: string; timezone: string }, horizonDays = 30, scenarioId?: string) {
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 365) throw new Error("Invalid forecast horizon");
  const [balanceEvidence, wealth, preferencesResult,
    { data: allocations, error: allocationsError }, { data: assumptions, error: assumptionsError },
    { data: rates, error: ratesError }] = await Promise.all([
      loadBalanceEvidence(supabase, workspace.id),
      loadWealthItems(supabase, workspace.id),
      supabase.from("forecast_preferences").select("currency_code, safety_buffer_minor::text, daily_spending_minor::text, uncertainty_bps, spending_account_id, spending_starts_on, version").eq("workspace_id", workspace.id).maybeSingle(),
      supabase.from("goal_allocations").select("account_id, amount_minor::text").eq("workspace_id", workspace.id),
      supabase.from("financial_assumptions").select("id, name, account_id, amount_minor::text, currency_code, cadence, starts_on, ends_on, enabled")
        .eq("workspace_id", workspace.id).eq("enabled", true).eq("confirmed", true).is("removed_at", null).order("id"),
      supabase.from("fx_rates").select("from_currency, to_currency, rate_text, rate_date, source")
        .eq("workspace_id", workspace.id).eq("to_currency", workspace.display_currency),
    ]);
  for (const error of [preferencesResult.error, allocationsError, assumptionsError, ratesError]) if (error) throw error;
  const preferences = preferencesResult.data ? forecastPreferencesSchema.parse(preferencesResult.data) : defaultForecastPreferences(workspace.display_currency);
  const preferencesVersion = preferencesResult.data?.version ?? 0;
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
    .filter(account => !account.archived_at && ["checking", "savings", "cash", "wallet"].includes(account.type ?? ""));
  const startDate = calendarDate(balanceEvidence.asOf, workspace.timezone);
  const accountIds = new Set(spendable.map(account => account.id));
  const missingInputs = (assumptions ?? []).flatMap(item =>
    !item.account_id || !accountIds.has(item.account_id) ? [`assumption account`] :
      []);
  const debts = buildDebtForecast(wealth, balanceEvidence.accounts, balanceEvidence.ledger, assumptions ?? [], startDate, horizonDays);
  missingInputs.push(...debts.missingInputs);
  const events: ForecastEvent[] = (assumptions ?? []).filter(item => item.account_id && accountIds.has(item.account_id) && !debts.excludedAssumptionIds.includes(item.id)).flatMap(item =>
    expandSchedule(item, startDate, horizonDays, preferences.uncertainty_bps).flatMap(event => {
      const cv = (amount: bigint) => convert(amount, item.currency_code, event.date);
      const expectedMinor = cv(event.expectedMinor), conservativeMinor = cv(event.conservativeMinor!), optimisticMinor = cv(event.optimisticMinor!);
      if (expectedMinor === null || conservativeMinor === null || optimisticMinor === null) { missingInputs.push(`fx:assumption:${item.account_id}`); return []; }
      return [{ ...event, expectedMinor, conservativeMinor, optimisticMinor, source: "confirmed" as const, name: item.name }];
    }));
  for (const repayment of debts.events) {
    const amount = convert(repayment.amountMinor, repayment.currencyCode, repayment.date);
    if (amount === null) { missingInputs.push(`fx:debt:${repayment.accountId}`); continue; }
    if (events.some(event => event.accountId === repayment.accountId && event.date === repayment.date && event.expectedMinor === amount)) {
      missingInputs.push(`debt:${repayment.accountId}:matching obligation needs association`); continue;
    }
    events.push({ date: repayment.date, accountId: repayment.accountId, expectedMinor: amount, conservativeMinor: amount, optimisticMinor: amount, source: "debt", name: "Debt repayment" });
  }
  if (BigInt(preferences.daily_spending_minor) > 0n) {
    if (!preferences.spending_account_id || !accountIds.has(preferences.spending_account_id)) missingInputs.push("estimated spending account");
    else for (const event of expandSchedule({ account_id: preferences.spending_account_id, currency_code: preferences.currency_code, amount_minor: (-BigInt(preferences.daily_spending_minor)).toString(), cadence: "daily", starts_on: preferences.spending_starts_on!, ends_on: null }, startDate, horizonDays, preferences.uncertainty_bps)) {
      const expectedMinor = convert(event.expectedMinor, preferences.currency_code, event.date);
      const conservativeMinor = convert(event.conservativeMinor!, preferences.currency_code, event.date);
      const optimisticMinor = convert(event.optimisticMinor!, preferences.currency_code, event.date);
      if (expectedMinor === null || conservativeMinor === null || optimisticMinor === null) missingInputs.push("fx:estimated spending");
      else events.push({ ...event, expectedMinor, conservativeMinor, optimisticMinor, source: "estimated", name: "Additional variable spending" });
    }
  }
  const safetyBufferMinor = BigInt(preferences.safety_buffer_minor) === 0n ? 0n : convert(BigInt(preferences.safety_buffer_minor), preferences.currency_code, startDate);
  if (safetyBufferMinor === null) missingInputs.push("fx:safety buffer");
  let scenarioEvents: ForecastEvent[] = [];
  if (scenarioId) {
    const { data: scenario } = await supabase.from("scenarios").select("id").eq("workspace_id", workspace.id).eq("id", scenarioId).is("removed_at", null).maybeSingle();
    if (!scenario) throw new Error("Scenario not found");
    const { data: overrides, error } = await supabase.from("scenario_overrides")
      .select("id, name, account_id, amount_delta_minor::text, currency_code, cadence, starts_on, ends_on")
      .eq("workspace_id", workspace.id).eq("scenario_id", scenarioId).is("removed_at", null).order("id");
    if (error) throw error;
    missingInputs.push(...(overrides ?? []).flatMap(item => !item.account_id || !accountIds.has(item.account_id) ? ["scenario account"] : []));
    scenarioEvents = (overrides ?? []).flatMap(item => item.account_id && accountIds.has(item.account_id)
      ? expandSchedule({ ...item, amount_minor: item.amount_delta_minor }, startDate, horizonDays, preferences.uncertainty_bps).flatMap(event => {
        const cv = (amount: bigint) => convert(amount, item.currency_code, event.date);
        const expectedMinor = cv(event.expectedMinor), conservativeMinor = cv(event.conservativeMinor!), optimisticMinor = cv(event.optimisticMinor!);
        if (expectedMinor === null || conservativeMinor === null || optimisticMinor === null) { missingInputs.push(`fx:scenario:${item.id}`); return []; }
        return [{ ...event, expectedMinor, conservativeMinor, optimisticMinor, source: "scenario" as const, name: item.name }];
      }) : []);
  }
  const input: ForecastInput = {
    startDate, horizonDays, currencyCode: workspace.display_currency,
    accounts: spendable.map((account, index) => {
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
        safetyBufferMinor: index === 0 ? safetyBufferMinor ?? 0n : 0n,
        reservedMinor: reservedMinor ?? 0n };
    }),
    events, scenarioEvents, missingInputs,
  };
  const forecast = forecastDaily(input);
  const available = availableToSpend(input);
  return { forecast, available, input, preferences, preferencesVersion };
}
