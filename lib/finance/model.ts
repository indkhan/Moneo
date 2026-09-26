import { availableToSpend, forecastDaily, type ForecastEvent, type ForecastInput } from "./calculations";
import { requireWorkspace } from "../auth";

type Scheduled = { account_id: string | null; amount_minor: string; currency_code: string; cadence: string; starts_on: string; ends_on: string | null; enabled?: boolean };

export function expandSchedule(item: Scheduled, start: string, days: number): ForecastEvent[] {
  if (item.enabled === false || !item.account_id) return [];
  const first = new Date(`${item.starts_on}T00:00:00Z`);
  const horizon = new Date(`${start}T00:00:00Z`);
  const end = new Date(horizon.getTime() + days * 86400000);
  const events: ForecastEvent[] = [];
  const elapsedDays = Math.max(0, Math.floor((horizon.getTime() - first.getTime()) / 86400000));
  const firstIndex = item.cadence === "daily" ? elapsedDays
    : item.cadence === "weekly" ? Math.floor(elapsedDays / 7)
    : item.cadence === "monthly" ? Math.max(0, (horizon.getUTCFullYear() - first.getUTCFullYear()) * 12 + horizon.getUTCMonth() - first.getUTCMonth() - 1)
    : 0;
  for (let n = firstIndex; n < firstIndex + days + 2; n++) {
    const date = new Date(first);
    if (item.cadence === "once" && n > 0) break;
    if (item.cadence === "daily") date.setUTCDate(first.getUTCDate() + n);
    else if (item.cadence === "weekly") date.setUTCDate(first.getUTCDate() + 7 * n);
    else if (item.cadence === "monthly") {
      date.setUTCDate(1);
      date.setUTCMonth(first.getUTCMonth() + n);
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(first.getUTCDate(), lastDay));
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
  const [{ data: accounts, error: accountsError }, { data: snapshots, error: snapshotsError },
    { data: allocations, error: allocationsError }, { data: assumptions, error: assumptionsError }] = await Promise.all([
      supabase.from("accounts").select("id, type, currency_code").eq("workspace_id", workspace.id),
      supabase.from("balance_snapshots").select("account_id, amount_minor, currency_code, as_of")
        .eq("workspace_id", workspace.id).order("as_of", { ascending: false }),
      supabase.from("goal_allocations").select("account_id, amount_minor").eq("workspace_id", workspace.id),
      supabase.from("financial_assumptions").select("account_id, amount_minor, currency_code, cadence, starts_on, ends_on, enabled")
        .eq("workspace_id", workspace.id).eq("enabled", true),
    ]);
  for (const error of [accountsError, snapshotsError, allocationsError, assumptionsError]) if (error) throw error;
  const latest = new Map<string, NonNullable<typeof snapshots>[number]>();
  for (const snapshot of snapshots ?? []) if (!latest.has(snapshot.account_id)) latest.set(snapshot.account_id, snapshot);
  const reserved = new Map<string, bigint>();
  for (const allocation of allocations ?? []) reserved.set(allocation.account_id, (reserved.get(allocation.account_id) ?? 0n) + BigInt(allocation.amount_minor));
  const spendable = (accounts ?? []).filter(account => ["checking", "savings", "cash", "wallet"].includes(account.type));
  const startDate = new Date().toISOString().slice(0, 10);
  const accountIds = new Set(spendable.map(account => account.id));
  const missingInputs = (assumptions ?? []).flatMap(item =>
    !item.account_id || !accountIds.has(item.account_id) ? [`assumption account`] :
      item.currency_code !== workspace.display_currency ? [`fx:assumption:${item.account_id}`] : []);
  const events = (assumptions ?? []).filter(item => item.account_id && accountIds.has(item.account_id) && item.currency_code === workspace.display_currency)
    .flatMap(item => expandSchedule(item, startDate, horizonDays));
  let scenarioEvents: ForecastEvent[] = [];
  if (scenarioId) {
    const { data: scenario } = await supabase.from("scenarios").select("id").eq("workspace_id", workspace.id).eq("id", scenarioId).maybeSingle();
    if (!scenario) throw new Error("Scenario not found");
    const { data: overrides, error } = await supabase.from("scenario_overrides")
      .select("id, account_id, amount_delta_minor, currency_code, cadence, starts_on, ends_on")
      .eq("workspace_id", workspace.id).eq("scenario_id", scenarioId);
    if (error) throw error;
    missingInputs.push(...(overrides ?? []).flatMap(item => !item.account_id || !accountIds.has(item.account_id) ? ["scenario account"] : item.currency_code !== workspace.display_currency ? [`fx:scenario:${item.id}`] : []));
    scenarioEvents = (overrides ?? []).filter(item => item.account_id && accountIds.has(item.account_id) && item.currency_code === workspace.display_currency)
      .flatMap(item => expandSchedule({ ...item, amount_minor: item.amount_delta_minor }, startDate, horizonDays));
  }
  const input: ForecastInput = {
    startDate, horizonDays, currencyCode: workspace.display_currency,
    accounts: spendable.map(account => ({ id: account.id, currencyCode: account.currency_code,
      balanceMinor: latest.has(account.id) ? BigInt(latest.get(account.id)!.amount_minor) : null,
      reservedMinor: reserved.get(account.id) ?? 0n })),
    events, scenarioEvents, missingInputs,
  };
  const forecast = forecastDaily(input);
  const available = availableToSpend(input);
  return { forecast, available, input };
}
