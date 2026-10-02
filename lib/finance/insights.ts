import { createHash } from "node:crypto";
import { z } from "zod";
import { INSIGHT_TYPES } from "@/lib/settings";
import { formatMoney } from "./format";
import { buildReviewInvestigation, type ReviewTransaction } from "./review";
import { minorDigits } from "./fx";

export const insightPreferencesSchema = z.object({ important_only: z.boolean().default(true),
  minimum_change_minor: z.string().regex(/^\d{1,19}$/).refine(value => BigInt(value) <= 9223372036854775807n).default("2000"), currency_code: z.string().refine(value => { try { minorDigits(value); return true; } catch { return false; } }).default("EUR"),
  upcoming_days: z.number().int().min(1).max(30).default(7), max_items: z.number().int().min(1).max(20).default(8) });
export const DEFAULT_INSIGHT_PREFERENCES = insightPreferencesSchema.parse({});
export function defaultInsightPreferences(currency: string): InsightPreferences {
  return { ...DEFAULT_INSIGHT_PREFERENCES, currency_code: currency, minimum_change_minor: (20n * 10n ** BigInt(minorDigits(currency))).toString() };
}
export type InsightPreferences = z.infer<typeof insightPreferencesSchema>;
export type Insight = { key: string; type: typeof INSIGHT_TYPES[number]; priority: "important" | "context"; title: string; detail: string; href: string; asOf: string };
export type InsightInput = {
  today: string; currency: string; locale?: string; transactions: (ReviewTransaction & { account_id?: string })[]; categories: { id: string; name: string }[];
  canonicalTransactions?: (ReviewTransaction & { account_id?: string })[];
  budgets: { id: string; name: string; currency: string; spentMinor: string; allowanceMinor: string; partial: boolean }[];
  recurring: { id: string; label: string; evidence_invalidated: boolean; evidence?: unknown }[];
  obligations: { id: string; name: string; date: string; amountMinor: string; currency: string }[];
  goals: { id: string; name: string; targetMinor: string; savedMinor: string | null; savedAsOf: string | null }[];
  wealth: { id: string; name: string; kind: string; amountMinor: string; currency: string; asOf: string }[];
  missingInputs: string[]; available: { amountMinor: string; limitingDate: string } | null;
};

export function buildInsights(input: InsightInput, preferences: InsightPreferences, muted: readonly string[] = [], dismissedKeys: readonly string[] = []): Insight[] {
  const results: Insight[] = [];
  const dismissed = new Set(dismissedKeys);
  function add(type: Insight["type"], entity: string, evidence: unknown, title: string, detail: string, href: string, priority: Insight["priority"] = "important") {
    if (muted.includes(type) || preferences.important_only && priority === "context") return;
    const key = createHash("sha256").update(JSON.stringify([type, entity, evidence])).digest("hex");
    if (dismissed.has(key)) return;
    results.push({ key, type, title, detail, href, priority, asOf: input.today });
  }
  const money = (amount: bigint | string, currency: string) => formatMoney(amount, currency, input.locale);
  const from = `${input.today.slice(0, 7)}-01`;
  const investigation = buildReviewInvestigation(input.transactions, { from, to: input.today }, input.categories, []);
  for (const group of investigation.categories) {
    const previous = BigInt(group.previousSpendingMinor), change = BigInt(group.changeMinor);
    const uncertain = input.transactions.some(row => row.status === "posted" && row.review_reasons?.length && row.currency_code === group.currency
      && row.posted_on >= investigation.comparisonPeriod.from && row.posted_on <= input.today && (row.category_id === null || row.category_id === group.id || row.refund_category_id === group.id));
    if (group.currency !== preferences.currency_code || previous <= 0n || change < BigInt(preferences.minimum_change_minor) || change * 5n < previous || uncertain) continue;
    add("spending_changes", group.id ?? "uncategorized", [from, input.today, group.currency, group.spendingMinor, group.previousSpendingMinor], `${group.name} spending increased`,
      `${money(group.spendingMinor, group.currency)} in ${from}–${input.today}, compared with ${money(group.previousSpendingMinor, group.currency)} in ${investigation.comparisonPeriod.from}–${investigation.comparisonPeriod.to}. Equal-length booked periods; incomplete imports can affect this comparison.`, group.sourceLinks[0] ?? "/money/transactions");
  }
  for (const budget of input.budgets) {
    const spent = BigInt(budget.spentMinor), allowance = BigInt(budget.allowanceMinor);
    if (budget.partial || (allowance > 0n ? spent * 5n < allowance * 4n : allowance - spent >= 0n)) continue;
    add("budget_pressure", budget.id, [input.today.slice(0, 7), budget.currency, budget.spentMinor, budget.allowanceMinor], `${budget.name} budget pressure`,
      `${money(spent, budget.currency)} spent against ${money(allowance, budget.currency)} allowance in ${input.today.slice(0, 7)}, including supported rollover.`, "/plan/spending");
  }
  const reviewed = (input.canonicalTransactions ?? input.transactions).filter(row => row.status === "posted" && row.kind === "ordinary" && !row.review_reasons?.length && BigInt(row.amount_minor) < 0n && row.posted_on <= input.today);
  for (const row of reviewed.filter(row => row.posted_on >= new Date(Date.parse(`${input.today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10))) {
    const peers = reviewed.filter(peer => peer.id !== row.id && peer.account_id === row.account_id && peer.currency_code === row.currency_code && peer.posted_on < row.posted_on).map(peer => -BigInt(peer.amount_minor)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    if (peers.length < 10 || row.currency_code !== preferences.currency_code) continue;
    const median = peers.length % 2 ? peers[Math.floor(peers.length / 2)] : (peers[peers.length / 2 - 1] + peers[peers.length / 2] + 1n) / 2n;
    const amount = -BigInt(row.amount_minor);
    if (median <= 0n || amount < median * 3n || amount - median < BigInt(preferences.minimum_change_minor)) continue;
    add("unusual_activity", row.id, [row.posted_on, row.amount_minor, row.currency_code, median.toString(), peers.length], "Large compared with recent account spending",
      `${money(amount, row.currency_code)} on ${row.posted_on}, compared with a median of ${money(median, row.currency_code)} across ${peers.length} earlier reviewed expenses in this account, rounded half up to the nearest minor unit. This comparison does not establish fraud or a cause.`, `/money/transactions?transaction=${row.parent_transaction_id ?? row.id}`);
  }
  for (const series of input.recurring.filter(series => series.evidence_invalidated)) add("recurring_changes", series.id, series.evidence ?? "invalidated", `${series.label} source evidence changed`, "Review the recurring payment evidence before relying on its inferred obligation. Intentional user assumptions are preserved.", "/money/recurring");
  const lookahead = new Date(Date.parse(`${input.today}T00:00:00Z`) + preferences.upcoming_days * 86400000).toISOString().slice(0, 10);
  for (const obligation of input.obligations.filter(row => row.date >= input.today && row.date <= lookahead && BigInt(row.amountMinor) < 0n)) add("upcoming_obligations", obligation.id, [obligation.date, obligation.amountMinor, obligation.currency], `${obligation.name} is upcoming`, `${money(obligation.amountMinor, obligation.currency)} confirmed in the forecast for ${obligation.date}. Future amounts remain assumptions until posted.`, "/plan");
  if (input.available && BigInt(input.available.amountMinor) < 0n) add("cash_shortfall", "forecast", [input.available.amountMinor, input.available.limitingDate, input.currency], "Forecast cash shortfall", `${money(input.available.amountMinor, input.currency)} at the conservative limiting date ${input.available.limitingDate}. Review confirmed obligations, holds and protected funds.`, "/plan");
  for (const goal of input.goals) if (goal.savedMinor !== null && goal.savedAsOf !== null && goal.savedAsOf <= input.today && BigInt(goal.targetMinor) > 0n && BigInt(goal.savedMinor) * 10n >= BigInt(goal.targetMinor) * 9n) add("goal_progress", goal.id, [goal.savedMinor, goal.targetMinor, goal.savedAsOf], `${goal.name} recorded savings milestone`, `Recorded savings cover at least 90% of the target as of ${goal.savedAsOf}. Virtual reservations are separate and do not prove actual savings.`, "/plan", "context");
  for (const item of input.wealth.filter(item => item.asOf === input.today)) add("asset_debt", item.id, [item.amountMinor, item.currency, item.asOf], `${item.name} dated ${item.kind} context`, `${money(item.amountMinor, item.currency)} recorded on ${item.asOf}. Manual valuation evidence does not prove a trend or increase spendable cash.`, "/money/wealth", "context");
  for (const missing of [...new Set(input.missingInputs)].sort()) add("data_quality", missing, missing, "Financial evidence needs attention", missing, "/plan");
  return results.sort((a, b) => (a.priority === "important" ? 0 : 1) - (b.priority === "important" ? 0 : 1) || a.type.localeCompare(b.type) || a.key.localeCompare(b.key)).slice(0, preferences.max_items);
}
