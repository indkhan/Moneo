import Link from "next/link";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildInsights, insightPreferencesSchema, defaultInsightPreferences, type InsightInput } from "@/lib/finance/insights";
import { describeMissingInputs } from "@/lib/finance/format";
import { type ReviewTransaction } from "@/lib/finance/review";
import { budgetProgress, type MonthlyLimit } from "@/lib/finance/spending-plans";
import { type WorkspaceSettings } from "@/lib/settings";
import type { evaluatePlan } from "@/lib/finance/model";
import { dismissInsight } from "./actions";
import { buildSourceCoverage, loadSourceCoverageMetadata, sourceCoverageNeedsReview } from "@/lib/finance/source-coverage";

const card = "min-w-0 rounded-xl border border-border bg-card p-5";

type Projection = Awaited<ReturnType<typeof evaluatePlan>>;
type Budget = { id: string; category_id: string; currency_code: string; limit_minor: string; enabled: boolean; rollover: boolean; rollover_from: string };
type Goal = { id: string; name: string; target_minor: string; recorded_saved_minor: string | null; saved_as_of: string | null; status: string };
type Recurring = { id: string; label: string; evidence_invalidated: boolean; evidence_baseline: { id: string }[] | null; invalidated_assumption_version: number | null };
type Wealth = { id: string; name: string; kind: string; amount_minor: string; currency_code: string; as_of: string; removed_at?: string | null };

type InsightPanelProps = {
  db: SupabaseClient; workspaceId: string; currency: string; today: string; settings: WorkspaceSettings; projection: Projection; missingInputs: string[]; names?: Map<string, string>; wealth: Wealth[];
};
// Database reads only, memoized per request so Home can start them before its own data
// resolves; nothing here depends on the projection. Independent reads load together.
export const loadInsightEvidence = cache(async (db: SupabaseClient, workspaceId: string, currency: string, today: string) => {
    async function rows<T>(table: string, columns: string, start?: string): Promise<T[]> {
      const collected: T[] = [];
      for (let offset = 0; offset <= 10000; offset += 500) {
        let query = db.from(table).select(columns).eq("workspace_id", workspaceId);
        if (start) query = query.gte("posted_on", start).lte("posted_on", today);
        const result = await query.order(table === "insight_dismissals" ? "evidence_key" : "id").range(offset, offset + 499);
        if (result.error) throw result.error;
        if (offset === 10000 && result.data.length) throw new Error("Insight evidence exceeds the supported 10,000-row limit");
        collected.push(...result.data as T[]);
        if (result.data.length < 500) return collected;
      }
      return collected;
    }
    async function byIds<T>(columns: string, ids: string[]) {
      const pages = await Promise.all(Array.from({ length: Math.ceil(ids.length / 100) }, async (_, index) => {
        const page = await db.from("transactions").select(columns).eq("workspace_id", workspaceId).in("id", ids.slice(index * 100, index * 100 + 100));
        if (page.error) throw page.error;
        return page.data as unknown as T[];
      }));
      return pages.flat();
    }
    const recentStart = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86400000).toISOString().slice(0, 10);
    const columns = "id,parent_transaction_id,account_id,description,amount_minor::text,currency_code,status,kind,review_reasons,posted_on,category_id,merchant_id,refund_of_id";
    const canonicalColumns = columns.replace("parent_transaction_id,", "");
    const [pref, budgets, categories, goals, recurring, limits, dismissals, canonical, sourceMetadata] = await Promise.all([
      db.from("insight_preferences").select("important_only,minimum_change_minor::text,currency_code,upcoming_days,max_items").eq("workspace_id", workspaceId).maybeSingle(),
      rows<Budget>("spending_plans", "id,category_id,currency_code,limit_minor::text,enabled,rollover,rollover_from"), rows<{ id: string; name: string }>("categories", "id,name"),
      rows<Goal>("goals", "id,name,target_minor::text,recorded_saved_minor::text,saved_as_of,status"),
      rows<Recurring>("recurring_series", "id,label,evidence_invalidated,evidence_baseline,invalidated_assumption_version"),
      rows<MonthlyLimit & { id: string; plan_id: string }>("spending_plan_limits", "id,plan_id,effective_month,limit_minor::text,enabled,version"),
      rows<{ evidence_key: string }>("insight_dismissals", "evidence_key"),
      rows<ReviewTransaction & { account_id: string }>("transactions", canonicalColumns, recentStart),
      loadSourceCoverageMetadata(db, workspaceId, true),
    ]);
    if (pref.error) throw pref.error;
    const preferences = insightPreferencesSchema.parse(pref.data ?? defaultInsightPreferences(currency));
    const first = budgets.filter(budget => budget.enabled && budget.rollover).reduce((start, budget) => budget.rollover_from < start ? budget.rollover_from : start, recentStart);
    const recurringEvidence = new Map(canonical.map(row => [row.id, row]));
    const missingBaselineIds = [...new Set(recurring.flatMap(series => (series.evidence_baseline ?? []).map(row => row.id)))].filter(id => !recurringEvidence.has(id));
    if (missingBaselineIds.length > 10000) throw new Error("Recurring insight evidence exceeds the current bound");
    const [transactions, older] = await Promise.all([
      rows<ReviewTransaction & { account_id: string }>("effective_transactions", columns, first),
      byIds<ReviewTransaction & { account_id: string }>(canonicalColumns, missingBaselineIds),
    ]);
    for (const row of older) recurringEvidence.set(row.id, row);
    const refundIds = [...new Set(transactions.flatMap(row => row.refund_of_id ? [row.refund_of_id] : []))];
    const originals = await byIds<{ id: string; category_id: string | null }>("id,category_id", refundIds);
    for (const row of transactions) if (row.refund_of_id) row.refund_category_id = originals.find(original => original.id === row.refund_of_id)?.category_id ?? row.refund_category_id;
    return { preferences, budgets, categories, goals, recurring, limits, dismissals, canonical, sourceMetadata, first, transactions, recurringEvidence };
});

type InsightEvidence = Awaited<ReturnType<typeof loadInsightEvidence>>;
/** This month's progress for every enabled budget, shared by Home's Budgets card and the budget insights. */
export function budgetsThisMonth({ budgets, categories, limits, transactions, sourceMetadata }: InsightEvidence, today: string) {
  const spendingRows = transactions.map(row => ({ amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code, status: row.status, kind: row.kind, reviewReasons: row.review_reasons, postedOn: row.posted_on, categoryId: row.category_id,
    ...(row.refund_of_id ? { refundOfCategoryId: row.refund_category_id ?? null } : {}) }));
  return budgets.filter(budget => budget.enabled).map(budget => {
    const sourceCoverage = buildSourceCoverage({ from: budget.rollover ? budget.rollover_from : `${today.slice(0, 7)}-01`, to: today, currencyCode: budget.currency_code }, transactions, sourceMetadata?.imports, sourceMetadata?.sources);
    const progress = budgetProgress(spendingRows, budget.category_id, budget.currency_code, today.slice(0, 7), BigInt(budget.limit_minor), budget.rollover ? { startsMonth: budget.rollover_from.slice(0, 7), history: limits.filter(limit => limit.plan_id === budget.id) } : undefined, sourceCoverage);
    return { budget, name: categories.find(category => category.id === budget.category_id)?.name ?? "Category", progress, sourceCoverage };
  });
}

async function loadInsights({ db, workspaceId, currency, today, settings, projection, missingInputs, names, wealth }: InsightPanelProps) {
    const evidence = await loadInsightEvidence(db, workspaceId, currency, today);
    const { preferences, categories, goals, recurring, dismissals, canonical, sourceMetadata, first, transactions, recurringEvidence } = evidence;
    const sourceCoverage = buildSourceCoverage({ from: first, to: today }, transactions, sourceMetadata?.imports, sourceMetadata?.sources);
    const warnings = describeMissingInputs([...missingInputs, ...(projection.input.missingInputs ?? [])], names);
    if (transactions.some(row => row.status === "posted" && row.review_reasons?.length)) warnings.push("Some financial classifications need review; comparisons omit uncertain rows");
    const budgetEvidence: InsightInput["budgets"] = [];
    for (const { budget, name, progress, sourceCoverage: budgetCoverage } of budgetsThisMonth(evidence, today)) {
      if (progress.allowanceMinor === null) { if (progress.limitation) warnings.push(progress.limitation); continue; }
      budgetEvidence.push({ id: budget.id, name, currency: budget.currency_code,
        spentMinor: progress.spentMinor.toString(), allowanceMinor: progress.allowanceMinor.toString(), partial: progress.partial, sourceCoverage: budgetCoverage });
    }
    const events = projection.input.events.filter(event => event.source !== "estimated" && event.expectedMinor < 0n);
    const obligations = new Map<string, InsightInput["obligations"][number]>();
    for (const event of events) {
      const id = `${event.accountId}:${event.date}`, previous = obligations.get(id);
      obligations.set(id, { id, name: "Confirmed payments", date: event.date, amountMinor: ((previous ? BigInt(previous.amountMinor) : 0n) + event.expectedMinor).toString(), currency });
    }
    const insights = buildInsights({ today, currency, locale: settings.locale, transactions, canonicalTransactions: canonical, categories, budgets: budgetEvidence, sourceCoverage, forecastSourceCoverage: projection.sourceCoverage,
      recurring: recurring.map(series => ({ ...series, evidence: [series.invalidated_assumption_version, series.evidence_baseline, (series.evidence_baseline ?? []).map(row => recurringEvidence.get(row.id) ?? null)] })),
      obligations: [...obligations.values()],
      goals: goals.filter(goal => goal.status === "active").map(goal => ({ id: goal.id, name: goal.name, targetMinor: goal.target_minor, savedMinor: goal.recorded_saved_minor, savedAsOf: goal.saved_as_of })),
      wealth: wealth.filter(item => !item.removed_at).map(item => ({ id: item.id, name: item.name, kind: item.kind, amountMinor: item.amount_minor, currency: item.currency_code, asOf: item.as_of })),
      missingInputs: warnings, available: projection.available.status === "available" ? { amountMinor: projection.available.amountMinor.toString(), limitingDate: projection.available.limitingDate } : null,
    }, preferences, settings.muted_insight_types, dismissals.map(dismissal => dismissal.evidence_key));
    return insights;
}

export async function ImportantInsights(props: InsightPanelProps) {
  let insights: Awaited<ReturnType<typeof loadInsights>> | null = null;
  try { insights = await loadInsights(props); } catch { insights = null; }
  const header = <div className="flex items-baseline justify-between gap-2"><h2 className="text-sm font-medium">Important insights</h2><Link href="/settings" className="text-sm text-muted-foreground hover:text-foreground hover:underline">Customize</Link></div>;
  if (insights === null) return <section className={card}>{header}<p role="alert" className="mt-3 text-sm">Insights are unavailable right now. Your totals elsewhere are not affected.</p><Link href="/import" className="mt-3 inline-block text-sm font-medium text-brand hover:underline">Review imports</Link></section>;
  return <section className={card}>{header}
    <ul className="mt-2 divide-y divide-border">
      {insights.map(insight => <li key={insight.key} className="flex items-start gap-3 py-2">
        <div className="min-w-0 flex-1">
          <Link className="block truncate text-sm font-medium hover:underline" href={insight.href}>{insight.title}</Link>
          <p className="line-clamp-2 text-xs text-muted-foreground" title={insight.detail}><span className="capitalize">{insight.type.replaceAll("_", " ")}</span>{sourceCoverageNeedsReview(insight.sourceCoverage) ? " · sources incomplete" : ""} · {insight.detail}</p>
        </div>
        <form action={dismissInsight}><input type="hidden" name="key" value={insight.key} /><input type="hidden" name="type" value={insight.type} /><button className="rounded px-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Dismiss ${insight.title}`} title="Dismiss">×</button></form>
      </li>)}
    </ul>{!insights.length ? <p className="mt-3 text-sm text-muted-foreground">Nothing to flag right now.</p> : null}</section>;
}