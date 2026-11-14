import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { archiveDates, dayRange, netWorthSeries } from "@/app/money/wealth/net-worth";
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { investigate } from "@/lib/finance/investigation";
import { loadInvestigationDataset } from "@/lib/finance/investigation-reader";
import { readNetWorth } from "@/lib/finance/net-worth-source";
import type { AiDataScope } from "@/lib/settings";
import type { ChartDataset } from "./chart-spec";

// Exact series for chat charts, from the same calculations as the app's screens. Nothing here does its own money maths
// beyond adding up minor units: spending and income come from the investigation engine, balances and net worth from the
// balance series behind Home and Wealth.

const currency = z.string().regex(/^[A-Z]{3}$/).refine(code => { try { minorDigits(code); return true; } catch { return false; } }, "Unknown currency");
export const CHART_DATASETS = ["spending_by_category", "spending_by_merchant", "spending_by_month", "cashflow_by_month", "spending_by_day", "account_balance", "net_worth"] as const;
export const chartDataInput = z.object({
  dataset: z.enum(CHART_DATASETS),
  from: z.iso.date(), to: z.iso.date(),
  currency: currency.optional().describe("Amounts in this currency; other currencies are converted at their posting-date rate. Defaults to the display currency."),
  accountId: z.uuid().optional().describe("Required for account_balance"),
  limit: z.number().int().min(2).max(20).optional().describe("Top N categories or merchants; the rest are summed as Other. Default 10."),
}).strict().refine(input => input.from <= input.to, "From date is after to date")
  .refine(input => input.dataset !== "account_balance" || input.accountId, "account_balance needs an accountId");
export type ChartDataInput = z.infer<typeof chartDataInput>;

/** What each dataset reads, so the chat checks the owner's AI data scopes first. */
export function chartDataScopes(dataset: ChartDataInput["dataset"]): AiDataScope[] {
  if (dataset === "account_balance") return ["accounts"];
  if (dataset === "net_worth") return ["accounts", "planning"];
  return ["accounts", "transactions"];
}

type Context = { supabase: SupabaseClient; workspace: { id: string; timezone: string; display_currency: string; locale: string } };
const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY + 1;

/** Every month from the month of `from` to the month of `to`, as YYYY-MM. */
export function monthRange(from: string, to: string) {
  const months: string[] = [];
  let [year, month] = from.slice(0, 7).split("-").map(Number);
  for (let key = from.slice(0, 7); key <= to.slice(0, 7); key = `${year}-${String(month).padStart(2, "0")}`) {
    months.push(key);
    if (++month > 12) { year++; month = 1; }
  }
  return months;
}

/** The last day of a YYYY-MM month, or `cap` when the month isn't over yet. */
export function monthEnd(month: string, cap: string) {
  const [year, number] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
  return last < cap ? last : cap;
}

/** The largest `limit - 1` groups by amount, then everything else summed as one "Other" row, so the total is unchanged. */
export function topWithOther<T extends { label: string; amount: bigint }>(groups: T[], limit: number, other: (amount: bigint) => T) {
  const sorted = [...groups].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : a.label.localeCompare(b.label)));
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit - 1).reduce((sum, group) => sum + group.amount, 0n);
  return [...sorted.slice(0, limit - 1), other(rest)];
}

/** One row per key in order, with zero where nothing happened. */
export function filled(keys: string[], amounts: Map<string, bigint>) {
  return keys.map(key => ({ key, amount: amounts.get(key) ?? 0n }));
}

type Loaded = { dataset: ChartDataset; note?: string };

async function investigation(context: Context, input: ChartDataInput, groupBy: ("category" | "merchant" | "month" | "date")[], code: string, canReadImports: boolean) {
  const data = await loadInvestigationDataset({ version: 1, period: { from: input.from, to: input.to }, currencyPolicy: { mode: "base", currency: code }, groupBy, sort: "current-desc", page: { size: 1 } },
    context, { canReadImports, sourceVersions: false });
  const run = (metric: "spending" | "income") => investigate({ ...data.spec, metric }, data.rows, data.context);
  return { entities: data.context.entities, run };
}
const limitation = (result: ReturnType<typeof investigate>) => result.coverage.limitation;
// Groups with a missing FX rate keep what could be converted; the note says some rows are left out.
const groupAmount = (group: ReturnType<typeof investigate>["groups"][number]) => BigInt(group.availableCurrentMinor);

async function spendingBy(context: Context, input: ChartDataInput, code: string, dimension: "category" | "merchant", canReadImports: boolean): Promise<Loaded> {
  const { entities, run } = await investigation(context, input, [dimension], code, canReadImports);
  const result = run("spending");
  const names = new Map((dimension === "category" ? entities?.categories : entities?.merchants)?.map(entity => [entity.id, entity.name]) ?? []);
  const period = `from=${input.from}&to=${input.to}`;
  const groups = result.groups.map(group => {
    const id = group.dimensions[dimension] as string | null;
    return { label: id ? names.get(id) ?? "Unnamed" : dimension === "category" ? "Uncategorized" : "No merchant", amount: groupAmount(group), href: `/money/transactions?${dimension}=${id ?? "none"}&${period}` };
  }).filter(group => group.amount > 0n);
  const rows = topWithOther(groups, input.limit ?? 10, amount => ({ label: "Other", amount, href: "" }));
  return { dataset: { columns: { [dimension]: { kind: "text" }, spending: { kind: "money", currency: code }, link: { kind: "text" } },
    rows: rows.map(row => ({ [dimension]: row.label, spending: row.amount.toString(), link: row.href || null })) }, note: limitation(result) };
}

async function byMonth(context: Context, input: ChartDataInput, code: string, withIncome: boolean, canReadImports: boolean, today: string): Promise<Loaded> {
  const months = monthRange(input.from, input.to);
  if (months.length > 120) throw new Error("At most 120 months");
  const { run } = await investigation(context, input, ["month"], code, canReadImports);
  const totals = (result: ReturnType<typeof investigate>) => new Map(result.groups.map(group => [group.dimensions.month as string, groupAmount(group)]));
  const spending = run("spending");
  if (!withIncome) return { dataset: { columns: { month: { kind: "date" }, spending: { kind: "money", currency: code } },
    rows: filled(months, totals(spending)).map(row => ({ month: row.key, spending: row.amount.toString() })) }, note: limitation(spending) };
  const income = run("income");
  const incomeBy = totals(income), spendingBy = totals(spending);
  // Cash in accounts at each month's end, in this currency: the balance series behind Home and Wealth.
  const balances = await balanceSeries(context, months.map(month => monthEnd(month, today)), today);
  return { dataset: { columns: { month: { kind: "date" }, income: { kind: "money", currency: code }, spending: { kind: "money", currency: code }, net: { kind: "money", currency: code }, balance: { kind: "money", currency: code } },
    rows: months.map((month, index) => {
      const inflow = incomeBy.get(month) ?? 0n, outflow = spendingBy.get(month) ?? 0n;
      const balance = balances.points[index]?.accounts.get(code);
      return { month, income: inflow.toString(), spending: outflow.toString(), net: (inflow - outflow).toString(), balance: balance === undefined ? null : balance.toString() };
    }) },
  note: [limitation(spending) ?? limitation(income), "balance is the cash in accounts held in this currency at each month's end (today for the current month); it is empty before account data starts."].filter(Boolean).join(" ") };
}

async function spendingByDay(context: Context, input: ChartDataInput, code: string, canReadImports: boolean): Promise<Loaded> {
  if (daysBetween(input.from, input.to) > 366) throw new Error("Daily data covers at most 366 days");
  const { run } = await investigation(context, input, ["date"], code, canReadImports);
  const result = run("spending");
  const amounts = new Map(result.groups.map(group => [group.dimensions.date as string, groupAmount(group)]));
  return { dataset: { columns: { date: { kind: "date" }, spending: { kind: "money", currency: code } },
    rows: filled(dayRange(input.from, input.to), amounts).map(row => ({ date: row.key, spending: row.amount.toString() })) }, note: limitation(result) };
}

/** Balances on past dates from the balance series; today's from the resolved balances every screen shows. */
async function balanceSeries(context: Context, dates: string[], today: string) {
  const evidence = await loadBalanceEvidence(context.supabase, context.workspace.id);
  const timeZone = context.workspace.timezone;
  const past = netWorthSeries({ dates: dates.filter(date => date < today), timeZone, accountIds: new Set(evidence.accounts.map(account => account.id)),
    archivedOn: archiveDates(evidence.accounts, timeZone), snapshots: evidence.snapshots, ledger: evidence.ledger, valuations: [] });
  const resolved = resolveBalances(evidence.accounts.filter(account => !account.archived_at), evidence.snapshots, evidence.ledger, evidence.asOf, timeZone);
  const now = { date: today, accounts: new Map<string, bigint>(), accountValues: new Map<string, bigint>(), uncertain: [] as string[] };
  for (const account of resolved) if (account.balance.amount_minor !== null) {
    const amount = BigInt(account.balance.amount_minor);
    now.accountValues.set(account.id, amount);
    now.accounts.set(account.currency_code, (now.accounts.get(account.currency_code) ?? 0n) + amount);
  }
  const byDate = new Map(past.map(point => [point.date, point]));
  return { accounts: evidence.accounts, points: dates.map(date => date === today ? now : byDate.get(date)) };
}

async function accountBalance(context: Context, input: ChartDataInput, today: string): Promise<Loaded> {
  const to = input.to < today ? input.to : today;
  if (input.from > to) throw new Error("The period is in the future");
  if (daysBetween(input.from, to) > 366) throw new Error("Daily balances cover at most 366 days");
  const series = await balanceSeries(context, dayRange(input.from, to), today);
  const account = series.accounts.find(item => item.id === input.accountId);
  if (!account) throw new Error("Unknown account");
  if (input.currency && input.currency !== account.currency_code) throw new Error(`This account is in ${account.currency_code}`);
  const rows = series.points.flatMap(point => {
    const amount = point?.accountValues?.get(account.id);
    return point && amount !== undefined ? [{ date: point.date, balance: amount.toString() }] : [];
  });
  const unproven = series.points.filter(point => point?.accountValues?.has(account.id) && point.uncertain.length).length;
  return { dataset: { columns: { date: { kind: "date" }, balance: { kind: "money", currency: account.currency_code } }, rows },
    note: [`${account.name}, in ${account.currency_code}. Days before its data starts are left out.`, unproven ? `${unproven} day(s) can't be fully proven.` : ""].filter(Boolean).join(" ") };
}

async function netWorthTrend(context: Context, input: ChartDataInput, today: string): Promise<Loaded> {
  const code = context.workspace.display_currency;
  if (input.currency && input.currency !== code) throw new Error(`Net worth history is in the display currency, ${code}`);
  if (input.from > today) throw new Error("The period is in the future");
  const days = daysBetween(input.from, today);
  if (days > 366) throw new Error("Net worth history covers at most 366 days back from today");
  const read = await readNetWorth(context, { days });
  const trend = (read.trend ?? []).filter(point => point.date <= input.to);
  return { dataset: { columns: { date: { kind: "date" }, netWorth: { kind: "money", currency: code } }, rows: trend.map(point => ({ date: point.date, netWorth: point.amountMinor })) },
    note: `Same calculation as the net_worth tool's trend: ${code} amounts as recorded, without converting other currencies; days before data starts are left out.${trend.some(point => point.notProven) ? " Some days can't be fully proven." : ""}` };
}

export async function loadChartData(context: Context, raw: unknown, options: { canReadImports: boolean }): Promise<Loaded> {
  const input = chartDataInput.parse(raw);
  const today = calendarDate(new Date(), context.workspace.timezone);
  const code = input.currency ?? context.workspace.display_currency;
  switch (input.dataset) {
    case "spending_by_category": return spendingBy(context, input, code, "category", options.canReadImports);
    case "spending_by_merchant": return spendingBy(context, input, code, "merchant", options.canReadImports);
    case "spending_by_month": return byMonth(context, input, code, false, options.canReadImports, today);
    case "cashflow_by_month": return byMonth(context, input, code, true, options.canReadImports, today);
    case "spending_by_day": return spendingByDay(context, input, code, options.canReadImports);
    case "account_balance": return accountBalance(context, input, today);
    case "net_worth": return netWorthTrend(context, input, today);
  }
}

/**
 * What the model sees of a dataset: every row while it is short, else a summary. Amounts come formatted for quoting;
 * the chart takes the exact rows by datasetId.
 */
const FLOWS = new Set(["spending", "income", "net"]);
export function describeDataset(datasetId: string, { dataset, note }: Loaded, locale?: string) {
  const money = Object.entries(dataset.columns).flatMap(([name, column]) => "currency" in column ? [[name, column.currency] as const] : []);
  const formatted = (row: Record<string, string | null>) => ({ ...row, ...Object.fromEntries(money.map(([name, code]) => [`${name}Formatted`, row[name] === null ? null : formatMoney(row[name]!, code, locale)])) });
  const summary = Object.fromEntries(money.map(([name, code]) => {
    const values = dataset.rows.flatMap(row => row[name] === null ? [] : [{ label: Object.values(row)[0], amount: BigInt(row[name]!) }]);
    if (!values.length) return [name, null];
    const min = values.reduce((a, b) => (b.amount < a.amount ? b : a)), max = values.reduce((a, b) => (b.amount > a.amount ? b : a));
    const total = values.reduce((sum, value) => sum + value.amount, 0n);
    // Balances aren't added up over time; flows are.
    return [name, { ...(FLOWS.has(name) ? { totalFormatted: formatMoney(total, code, locale) } : {}), lowest: { at: min.label, formatted: formatMoney(min.amount, code, locale) }, highest: { at: max.label, formatted: formatMoney(max.amount, code, locale) },
      first: formatMoney(values[0].amount, code, locale), last: formatMoney(values.at(-1)!.amount, code, locale) }];
  }));
  return { datasetId, columns: dataset.columns, rowCount: dataset.rows.length,
    ...(dataset.rows.length <= 62 ? { rows: dataset.rows.map(formatted) } : { firstRows: dataset.rows.slice(0, 3).map(formatted), lastRows: dataset.rows.slice(-3).map(formatted), summary }),
    ...(note ? { note } : {}) };
}
