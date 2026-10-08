import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAiScope, type WorkspaceSettings } from "@/lib/settings";
import { loadBalanceEvidence } from "./balances";
import { calendarDate } from "./calendar";
import { buildReviewEvidence, buildPlanningReview, reviewNetWorth, type ReviewTransaction } from "./review";
import { evaluatePlanForWorkspace } from "./model";
import { loadWealthItems, wealthEvidence } from "./wealth";
import { buildSourceCoverage, loadSourceCoverageMetadata } from "./source-coverage";
import { investigationSchema } from "./investigation";
import { runInvestigation } from "./investigation-reader";
import { toolSourceVersion } from "./tool-evidence";

export async function loadFinancialReviewEvidence(db: SupabaseClient, workspace: { id: string; display_currency: string; timezone: string }, settings: WorkspaceSettings, query?: unknown) {
  requireAiScope(settings, "accounts", "transactions");
  const balances = await loadBalanceEvidence(db, workspace.id);
  const to = calendarDate(balances.asOf, settings.timezone);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 89 * 86400000).toISOString().slice(0, 10);
  const comparisonFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 90 * 86400000).toISOString().slice(0, 10);
  async function rows<T>(table: string, columns: string, periodFrom?: string): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; offset <= 10000; offset += 500) {
      let query = db.from(table).select(columns).eq("workspace_id", workspace.id);
      if (periodFrom) query = query.gte("posted_on", periodFrom).lte("posted_on", to);
      const page = await query.order("id").range(offset, offset + 499);
      if (page.error) throw page.error;
      if (offset === 10000 && page.data.length) throw new Error("Review evidence exceeds the current 10,000-row limit");
      result.push(...page.data as T[]);
      if (page.data.length < 500) break;
    }
    return result;
  }
  const budgets = settings.ai_data_scopes.includes("planning") ? await rows<Parameters<typeof buildPlanningReview>[0]["budgets"][number]>("spending_plans", "id, category_id, currency_code, limit_minor::text, enabled, rollover, rollover_from, version") : [];
  const historyStart = budgets.filter(budget => budget.enabled && budget.rollover && budget.rollover_from &&
    Date.parse(`${to.slice(0, 7)}-01T00:00:00Z`) - Date.parse(`${budget.rollover_from}T00:00:00Z`) <= 3660 * 86400000)
    .map(budget => budget.rollover_from!).sort()[0];
  const transactions = await rows<ReviewTransaction & { tags: string[]; event_name: string | null; version: number; description: string }>("effective_transactions", "id, account_id, parent_transaction_id, amount_minor::text, currency_code, status, kind, review_reasons, posted_on, category_id, merchant_id, refund_of_id, tags, event_name, version, description", historyStart && historyStart < comparisonFrom ? historyStart : comparisonFrom);
  const [categories, merchants] = await Promise.all([rows<{ id: string; name: string }>("categories", "id, name"), rows<{ id: string; name: string }>("merchants", "id, name")]);
  const refunds = [...new Set(transactions.flatMap(row => row.refund_of_id ? [row.refund_of_id] : []))];
  for (let offset = 0; offset < refunds.length; offset += 100) {
    const originals = await db.from("transactions").select("id, category_id").eq("workspace_id", workspace.id).in("id", refunds.slice(offset, offset + 100));
    if (originals.error) throw originals.error;
    for (const row of transactions) if (row.refund_of_id) row.refund_category_id = originals.data.find(original => original.id === row.refund_of_id)?.category_id ?? row.refund_category_id;
  }
  const current = transactions.filter(row => row.posted_on >= from);
  const sourceMetadata = await loadSourceCoverageMetadata(db, workspace.id, settings.ai_data_scopes.includes("imports"));
  const coverage = (scope: Parameters<typeof buildSourceCoverage>[0]) => buildSourceCoverage(scope, transactions, sourceMetadata?.imports, sourceMetadata?.sources);
  const sourceCoverage = coverage({ from, to });
  const base = { ...buildReviewEvidence(balances.accounts, balances.snapshots, current, from, to, { ...balances, timeZone: settings.timezone, sourceMetadata }), sourceCoverage };
  const defaultQuery = investigationSchema.parse({ version: 1, period: { from, to }, comparison: { from: comparisonFrom, to: new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) }, groupBy: ["category", "merchant"] });
  const queryInvestigation = await runInvestigation(query ?? defaultQuery, { supabase: db, workspace }, { canReadImports: settings.ai_data_scopes.includes("imports") });
  const investigation = { ...queryInvestigation, entities: { accounts: balances.accounts.map(a => ({ id: a.id, name: a.name })), categories, merchants } };
  const calculationEvidence = { balances: { accounts: balances.accounts, snapshots: balances.snapshots, ledger: balances.ledger }, transactions, categories, merchants, budgets, sourceMetadata };
  if (!settings.ai_data_scopes.includes("planning")) return { ...base, investigation, queryInvestigation, calculationEvidence, sourceVersion: toolSourceVersion(calculationEvidence), planning: { unavailable: "AI access to planning is disabled in Settings" } };
  const [goals, allocations, budgetHistory, assumptions, wealth, plan] = await Promise.all([
    rows<Parameters<typeof buildPlanningReview>[0]["goals"][number]>("goals", "id, name, currency_code, target_minor::text, recorded_saved_minor::text, saved_as_of, planned_monthly_minor::text, contribution_starts_on, target_date, status, version"),
    rows<{ goal_id: string; amount_minor: string }>("goal_allocations", "id, goal_id, account_id, amount_minor::text, version"),
    rows<NonNullable<Parameters<typeof buildPlanningReview>[0]["budgetHistory"]>[number]>("spending_plan_limits", "id, plan_id, limit_minor::text, enabled, version, effective_month"),
    rows<{ id: string; name: string; account_id: string | null; amount_minor: string; currency_code: string; cadence: string; starts_on: string; schedule_anchor_on: string | null; source: string; ends_on: string | null; confirmed: boolean; enabled: boolean; removed_at: string | null; version: number }>("financial_assumptions", "id, name, account_id, amount_minor::text, currency_code, cadence, starts_on, schedule_anchor_on, source, ends_on, confirmed, enabled, removed_at, version"),
    loadWealthItems(db, workspace.id), evaluatePlanForWorkspace(db, { ...workspace, timezone: settings.timezone }, 90, undefined,
      { canReadImports: settings.ai_data_scopes.includes("imports"), sourceMetadata: Promise.resolve(sourceMetadata) }),
  ]);
  const datedWealth = wealthEvidence(wealth, to);
  const budgetCoverage = Object.fromEntries(budgets.map(budget => [budget.id, coverage({ from: budget.rollover && budget.rollover_from ? budget.rollover_from : `${to.slice(0, 7)}-01`, to, currencyCode: budget.currency_code })]));
  const planning = { ...buildPlanningReview({ today: to, goals, allocations, budgets, budgetHistory, budgetCoverage, transactions, categories }),
    obligations: assumptions.filter(row => row.confirmed && row.enabled && !row.removed_at).map(row => ({ ...row, link: "/plan" })),
    wealth: { included: datedWealth.included, excludedLinked: datedWealth.excludedLinked, missingInputs: datedWealth.missingInputs, sourceCoverage: datedWealth.sourceCoverage, manualRecords: datedWealth.manualRecords, link: "/money/wealth" },
    forecast: { evaluatedOn: to, horizonDays: 90, currency: workspace.display_currency, sourceVersion: plan.sourceVersion, sourceCoverage: plan.sourceCoverage, resultBasis: plan.resultBasis, available: plan.available, daily: plan.forecast, obligations: plan.input.events, link: "/plan" } };
  // Workflow transport, persistence and prompts receive exact decimal strings, never JSON numbers for money.
  const fullCalculationEvidence = JSON.parse(JSON.stringify({ ...calculationEvidence, goals, allocations, budgetHistory, assumptions, wealth, planInput: plan.input, forecastSource: plan.calculationEvidence }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  return { ...base, accountBalanceTotals: base.netWorth, netWorth: reviewNetWorth(base.netWorth, wealth, to), investigation, queryInvestigation,
    calculationEvidence: fullCalculationEvidence, sourceVersion: toolSourceVersion(fullCalculationEvidence),
    planning: JSON.parse(JSON.stringify(planning, (_key, value) => typeof value === "bigint" ? value.toString() : value)) as Record<string, unknown> };
}
