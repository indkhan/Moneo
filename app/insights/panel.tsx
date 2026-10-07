import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildInsights, insightPreferencesSchema, defaultInsightPreferences, type InsightInput } from "@/lib/finance/insights";
import { type ReviewTransaction } from "@/lib/finance/review";
import { budgetProgress, type MonthlyLimit } from "@/lib/finance/spending-plans";
import { type WorkspaceSettings } from "@/lib/settings";
import type { evaluatePlan } from "@/lib/finance/model";
import { dismissInsight } from "./actions";
import { buildSourceCoverage, loadSourceCoverageMetadata } from "@/lib/finance/source-coverage";
import { SourceCoverageDetails } from "@/app/source-coverage";

type Projection = Awaited<ReturnType<typeof evaluatePlan>>;
type Budget = { id: string; category_id: string; currency_code: string; limit_minor: string; enabled: boolean; rollover: boolean; rollover_from: string };
type Goal = { id: string; name: string; target_minor: string; recorded_saved_minor: string | null; saved_as_of: string | null; status: string };
type Recurring = { id: string; label: string; evidence_invalidated: boolean; evidence_baseline: { id: string }[] | null; invalidated_assumption_version: number | null };
type Wealth = { id: string; name: string; kind: string; amount_minor: string; currency_code: string; as_of: string; removed_at?: string | null };

type InsightPanelProps = {
  db: SupabaseClient; workspaceId: string; currency: string; today: string; settings: WorkspaceSettings; projection: Projection; missingInputs: string[]; wealth: Wealth[];
};
async function loadInsights({ db, workspaceId, currency, today, settings, projection, missingInputs, wealth }: InsightPanelProps) {
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
    const pref = await db.from("insight_preferences").select("important_only,minimum_change_minor::text,currency_code,upcoming_days,max_items").eq("workspace_id", workspaceId).maybeSingle();
    if (pref.error) throw pref.error;
    const preferences = insightPreferencesSchema.parse(pref.data ?? defaultInsightPreferences(currency));
    const [budgets, categories, goals, recurring, limits, dismissals] = await Promise.all([
      rows<Budget>("spending_plans", "id,category_id,currency_code,limit_minor::text,enabled,rollover,rollover_from"), rows<{ id: string; name: string }>("categories", "id,name"),
      rows<Goal>("goals", "id,name,target_minor::text,recorded_saved_minor::text,saved_as_of,status"),
      rows<Recurring>("recurring_series", "id,label,evidence_invalidated,evidence_baseline,invalidated_assumption_version"),
      rows<MonthlyLimit & { id: string; plan_id: string }>("spending_plan_limits", "id,plan_id,effective_month,limit_minor::text,enabled,version"),
      rows<{ evidence_key: string }>("insight_dismissals", "evidence_key"),
    ]);
    const recentStart = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86400000).toISOString().slice(0, 10);
    const first = budgets.filter(budget => budget.enabled && budget.rollover).reduce((start, budget) => budget.rollover_from < start ? budget.rollover_from : start, recentStart);
    const columns = "id,parent_transaction_id,account_id,description,amount_minor::text,currency_code,status,kind,review_reasons,posted_on,category_id,merchant_id,refund_of_id";
    const transactions = await rows<ReviewTransaction & { account_id: string }>("effective_transactions", columns, first);
    const sourceMetadata = await loadSourceCoverageMetadata(db, workspaceId, true);
    const sourceCoverage = buildSourceCoverage({ from: first, to: today }, transactions, sourceMetadata?.imports, sourceMetadata?.sources);
    const canonical = await rows<ReviewTransaction & { account_id: string }>("transactions", columns.replace("parent_transaction_id,", ""), recentStart);
    const recurringEvidence = new Map(canonical.map(row => [row.id, row]));
    const missingBaselineIds = [...new Set(recurring.flatMap(series => (series.evidence_baseline ?? []).map(row => row.id)))].filter(id => !recurringEvidence.has(id));
    if (missingBaselineIds.length > 10000) throw new Error("Recurring insight evidence exceeds the current bound");
    for (let offset = 0; offset < missingBaselineIds.length; offset += 100) {
      const older = await db.from("transactions").select(columns.replace("parent_transaction_id,", "")).eq("workspace_id", workspaceId).in("id", missingBaselineIds.slice(offset, offset + 100));
      if (older.error) throw older.error;
      for (const row of older.data as unknown as (ReviewTransaction & { account_id: string })[]) recurringEvidence.set(row.id, row);
    }
    const refundIds = [...new Set(transactions.flatMap(row => row.refund_of_id ? [row.refund_of_id] : []))];
    for (let offset = 0; offset < refundIds.length; offset += 100) {
      const originals = await db.from("transactions").select("id,category_id").eq("workspace_id", workspaceId).in("id", refundIds.slice(offset, offset + 100));
      if (originals.error) throw originals.error;
      for (const row of transactions) if (row.refund_of_id) row.refund_category_id = originals.data.find(original => original.id === row.refund_of_id)?.category_id ?? row.refund_category_id;
    }
    const warnings = [...missingInputs, ...(projection.input.missingInputs ?? [])];
    if (transactions.some(row => row.status === "posted" && row.review_reasons?.length)) warnings.push("Some financial classifications need review; comparisons omit uncertain rows");
    const spendingRows = transactions.map(row => ({ amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code, status: row.status, kind: row.kind, reviewReasons: row.review_reasons, postedOn: row.posted_on, categoryId: row.category_id,
      ...(row.refund_of_id ? { refundOfCategoryId: row.refund_category_id ?? null } : {}) }));
    const budgetEvidence: InsightInput["budgets"] = [];
    for (const budget of budgets.filter(budget => budget.enabled)) {
      const budgetCoverage = buildSourceCoverage({ from: budget.rollover ? budget.rollover_from : `${today.slice(0, 7)}-01`, to: today, currencyCode: budget.currency_code }, transactions, sourceMetadata?.imports, sourceMetadata?.sources);
      const progress = budgetProgress(spendingRows, budget.category_id, budget.currency_code, today.slice(0, 7), BigInt(budget.limit_minor), budget.rollover ? { startsMonth: budget.rollover_from.slice(0, 7), history: limits.filter(limit => limit.plan_id === budget.id) } : undefined, budgetCoverage);
      if (progress.allowanceMinor === null) { if (progress.limitation) warnings.push(progress.limitation); continue; }
      budgetEvidence.push({ id: budget.id, name: categories.find(category => category.id === budget.category_id)?.name ?? "Category", currency: budget.currency_code,
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
  if (insights === null) return <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">Important insights</h2><p role="alert" className="mt-3 text-sm">Insight evidence is unavailable or exceeds the current bounded history. Financial totals elsewhere remain separate.</p><Link href="/import" className="text-sm underline">Review source evidence</Link></section>;
  return <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">Important insights</h2><ul className="mt-3 space-y-4">
      {insights.map(insight => <li key={insight.key} className="border-t border-border pt-3"><div className="flex items-start justify-between gap-3"><Link className="text-sm font-medium underline" href={insight.href}>{insight.title}</Link><form action={dismissInsight}><input type="hidden" name="key" value={insight.key} /><input type="hidden" name="type" value={insight.type} /><button className="text-xs text-muted-foreground underline" aria-label={`Dismiss ${insight.title}`}>Dismiss</button></form></div><p className="mt-1 text-sm text-muted-foreground">{insight.detail}</p><SourceCoverageDetails coverage={insight.sourceCoverage} /><p className="mt-1 text-xs text-muted-foreground">Evaluated {insight.asOf} · {insight.type.replaceAll("_", " ")}</p></li>)}
    </ul>{!insights.length ? <p className="mt-3 text-sm text-muted-foreground">No supported insights match your current preferences. Missing history does not prove that activity is normal.</p> : null}<Link href="/settings" className="mt-3 inline-block text-xs underline">Customize relevance, mute types or restore dismissals</Link></section>;
}
