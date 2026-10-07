import { accountLiquidity, availableToSpend, forecastDaily, type ForecastEvent, type ForecastInput } from "./calculations";
import { convertFx } from "./fx";
import { requireWorkspace } from "../auth";
import { loadBalanceEvidence, resolveBalances } from "./balances";
import { calendarDate } from "./calendar";
import { buildDebtForecast, loadWealthItems } from "./wealth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultForecastPreferences, forecastCases, forecastPreferencesSchema } from "./preferences";
import { reconcileOccurrence, settlementPosting, type OccurrenceSettlement } from "./recurring-occurrences";
import { buildSourceCoverage, loadSourceCoverageMetadata } from "./source-coverage";

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

export async function evaluatePlan(horizonDays = 30, scenarioId?: string, canReadImports = true) {
  const { supabase, workspace } = await requireWorkspace();
  return evaluatePlanForWorkspace(supabase, workspace, horizonDays, scenarioId, { canReadImports });
}

export async function evaluatePlanForWorkspace(supabase: SupabaseClient, workspace: { id: string; display_currency: string; timezone: string }, horizonDays = 30, scenarioId?: string,
  evidence?: { balanceEvidence?: ReturnType<typeof loadBalanceEvidence>; wealth?: ReturnType<typeof loadWealthItems>; canReadImports?: boolean; sourceMetadata?: ReturnType<typeof loadSourceCoverageMetadata> }) {
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 365) throw new Error("Invalid forecast horizon");
  async function allRows<T>(query: { range(from: number, to: number): PromiseLike<{ data: T[] | null; error: unknown }> }) {
    const rows: T[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await query.range(offset, offset + 499);
      if (page.error) throw page.error;
      rows.push(...(page.data ?? []));
      if (!page.data || page.data.length < 500) return rows;
    }
  }
  const sourceMetadataPromise = evidence?.sourceMetadata ?? loadSourceCoverageMetadata(supabase, workspace.id, evidence?.canReadImports ?? true);
  const [balanceEvidence, wealth, preferencesResult,
    allocations, assumptions, rates, recurringSeries, settlements, sourceMetadata] = await Promise.all([
      evidence?.balanceEvidence ?? loadBalanceEvidence(supabase, workspace.id),
      evidence?.wealth ?? loadWealthItems(supabase, workspace.id),
      supabase.from("forecast_preferences").select("currency_code, safety_buffer_minor::text, daily_spending_minor::text, uncertainty_bps, spending_account_id, spending_starts_on, version").eq("workspace_id", workspace.id).maybeSingle(),
      allRows(supabase.from("goal_allocations").select("account_id, amount_minor::text").eq("workspace_id", workspace.id).order("id")),
      allRows(supabase.from("financial_assumptions").select("id, name, source, account_id, amount_minor::text, currency_code, cadence, starts_on, ends_on, enabled")
        .eq("workspace_id", workspace.id).eq("enabled", true).eq("confirmed", true).is("removed_at", null).order("id")),
      allRows(supabase.from("fx_rates").select("from_currency, to_currency, rate_text, rate_date, source")
        .eq("workspace_id", workspace.id).eq("to_currency", workspace.display_currency).order("id")),
      allRows(supabase.from("recurring_series").select("id, assumption_id, recurring_series_transactions(transaction_id)")
        .eq("workspace_id", workspace.id).eq("status", "confirmed").eq("evidence_invalidated", false).order("id")),
      allRows<OccurrenceSettlement>(supabase.from("recurring_occurrence_settlements")
        .select("id, assumption_id, scheduled_on, transaction_id, completes_occurrence, receipt, undone_at, version")
        .eq("workspace_id", workspace.id).order("id")),
      sourceMetadataPromise,
    ]);
  if (preferencesResult.error) throw preferencesResult.error;
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
  const spendable = resolveBalances(balanceEvidence.accounts, balanceEvidence.snapshots, balanceEvidence.ledger, balanceEvidence.asOf, workspace.timezone, sourceMetadata)
    .filter(account => !account.archived_at && ["checking", "savings", "cash", "wallet"].includes(account.type ?? ""));
  const startDate = calendarDate(balanceEvidence.asOf, workspace.timezone);
  const accountIds = new Set(spendable.map(account => account.id));
  const missingInputs = (assumptions ?? []).flatMap(item =>
    !item.account_id || !accountIds.has(item.account_id) ? [`assumption account`] :
      []);
  const debts = buildDebtForecast(wealth, balanceEvidence.accounts, balanceEvidence.ledger, assumptions ?? [], startDate, horizonDays);
  missingInputs.push(...debts.missingInputs);
  const events: ForecastEvent[] = (assumptions ?? []).filter(item => item.account_id && accountIds.has(item.account_id) && !debts.excludedAssumptionIds.includes(item.id)).flatMap(item => {
    const planned = expandSchedule(item, startDate, horizonDays, preferences.uncertainty_bps);
    // Retain overdue explicit occurrences, including those reopened by undo or changed evidence.
    for (const date of new Set(settlements.filter(link => link.assumption_id === item.id && link.scheduled_on < startDate).map(link => link.scheduled_on))) {
      const past = expandSchedule(item, date, 1, preferences.uncertainty_bps);
      if (past[0]?.date === date) planned.push(past[0]);
    }
    return planned.flatMap(event => {
      const explicit = settlements.filter(link => link.assumption_id === item.id && link.scheduled_on === event.date);
      // Retiring an explicit association does not retire the independently confirmed anchor evidence.
      if (!explicit.some(link => !link.undone_at) && item.source === "recurring_confirmed" && event.date === item.starts_on && recurringSeries.some(series =>
        series.assumption_id === item.id && series.recurring_series_transactions.some((link: { transaction_id: string }) =>
          balanceEvidence.ledger.some(row => row.id === link.transaction_id && row.account_id === item.account_id &&
            row.currency_code === item.currency_code && row.status === "posted" && row.posted_on === event.date &&
            (!row.posted_at || Date.parse(row.posted_at) <= Date.parse(balanceEvidence.asOf)))))) return [];
      for (const link of explicit) if (!link.undone_at && !settlementPosting(item, link, balanceEvidence.ledger))
        missingInputs.push(`occurrence:${item.name}:${event.date}:${link.id}:evidence changed; undo or review the association`);
      if (explicit.length) return reconcileOccurrence(item, event.date, explicit, balanceEvidence.ledger, balanceEvidence.asOf, startDate, workspace.timezone).flatMap(movement => {
        const horizonEnd = new Date(`${startDate}T00:00:00Z`).getTime() + horizonDays * 86400000;
        if (Date.parse(`${movement.date}T00:00:00Z`) >= horizonEnd) return [];
        const cases = forecastCases(movement.amountMinor, movement.observed ? 0 : preferences.uncertainty_bps);
        const expectedMinor = convert(cases.expectedMinor, item.currency_code, movement.date);
        const conservativeMinor = convert(cases.conservativeMinor!, item.currency_code, movement.date);
        const optimisticMinor = convert(cases.optimisticMinor!, item.currency_code, movement.date);
        if (expectedMinor === null || conservativeMinor === null || optimisticMinor === null) { missingInputs.push(`fx:assumption:${item.account_id}`); return []; }
        return [{ ...event, date: movement.date, expectedMinor, conservativeMinor, optimisticMinor, source: "confirmed" as const, name: item.name }];
      });
      const cv = (amount: bigint) => convert(amount, item.currency_code, event.date);
      const expectedMinor = cv(event.expectedMinor), conservativeMinor = cv(event.conservativeMinor!), optimisticMinor = cv(event.optimisticMinor!);
      if (expectedMinor === null || conservativeMinor === null || optimisticMinor === null) { missingInputs.push(`fx:assumption:${item.account_id}`); return []; }
      return [{ ...event, expectedMinor, conservativeMinor, optimisticMinor, source: "confirmed" as const, name: item.name }];
    });
  });
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
    const overrides = await allRows(supabase.from("scenario_overrides")
      .select("id, name, account_id, amount_delta_minor::text, currency_code, cadence, starts_on, ends_on")
      .eq("workspace_id", workspace.id).eq("scenario_id", scenarioId).is("removed_at", null).order("id"));
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
    workspaceBufferMinor: safetyBufferMinor ?? 0n,
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
        const outstanding = -BigInt(row.amount_minor) - BigInt(row.pending_released_minor ?? "0");
        if (outstanding < 0n) throw new Error("Pending releases exceed the recorded hold");
        const hold = convert(outstanding, row.currency_code, startDate);
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
  const boundary = spendable.some(account => !account.balance.as_of) ? undefined : spendable.flatMap(account => account.balance.as_of ? [calendarDate(account.balance.as_of, workspace.timezone)] : []).sort()[0];
  const coverageEnd = new Date(Date.parse(`${startDate}T00:00:00Z`) + horizonDays * 86400000).toISOString().slice(0, 10);
  const sourceCoverage = buildSourceCoverage({ from: boundary ?? "0001-01-01", to: coverageEnd, accountIds: [...accountIds], ledgerBasis: "balance_activity" },
    balanceEvidence.ledger.filter(row => accountIds.has(row.account_id)).map(row => ({ ...row, kind: row.kind ?? "ordinary" })), sourceMetadata?.imports, sourceMetadata?.sources);
  return { forecast, available, liquidity: accountLiquidity(input), input, preferences, preferencesVersion, sourceCoverage,
    resultBasis: "accepted balance evidence and confirmed assumptions; source completeness unknown" };
}
