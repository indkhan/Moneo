import Link from "next/link";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { Sparkle } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { allPages } from "@/lib/all-pages";
import { accountShortfalls, buildInsights, insightPreferencesSchema, defaultInsightPreferences, type Insight, type InsightInput } from "@/lib/finance/insights";
import { briefingFindings, keepsFacts, plainWording, rephraseFindings } from "@/lib/ai/briefing";
import { getModel, modelIdFor } from "@/lib/ai/provider";
import { describeMissingInputs, formatInputAmount } from "@/lib/finance/format";
import { type ReviewTransaction } from "@/lib/finance/review";
import { loadLoanPayoutIds } from "@/lib/finance/iou";
import { budgetProgress, type MonthlyLimit } from "@/lib/finance/spending-plans";
import { requireAiScope, type WorkspaceSettings } from "@/lib/settings";
import type { evaluatePlan } from "@/lib/finance/model";
import { dismissInsight, dismissInsights, muteInsightType } from "./actions";
import { buildSourceCoverage, loadSourceCoverageMetadata, sourceCoverageNeedsReview } from "@/lib/finance/source-coverage";

const card = "min-w-0 rounded-xl border border-border bg-card p-6 sm:p-7";

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
      const collected = await allPages<T>((from, to, count) => {
        let query = db.from(table).select(columns, count ? { count } : undefined).eq("workspace_id", workspaceId);
        if (start) query = query.gte("posted_on", start).lte("posted_on", today);
        return query.order(table === "insight_dismissals" ? "evidence_key" : "id").range(from, to);
      });
      if (collected.length > 10000) throw new Error("Insight evidence exceeds the supported 10,000-row limit");
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
    const [effective, older, loans] = await Promise.all([
      rows<ReviewTransaction & { account_id: string }>("effective_transactions", columns, first),
      byIds<ReviewTransaction & { account_id: string }>(canonicalColumns, missingBaselineIds),
      loadLoanPayoutIds(db, workspaceId).catch(() => new Set<string>()),
    ]);
    // Money lent or repaid is not spending: the briefing and budgets treat it like a transfer.
    const transactions = effective.map(row => loans.has(row.parent_transaction_id ?? row.id) ? { ...row, kind: "transfer" as const } : row);
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
      accountShortfalls: projection.liquidity?.status === "available" ? accountShortfalls(projection.liquidity.accounts, names ?? new Map()) : [],
    }, preferences, settings.muted_insight_types, dismissals.map(dismissal => dismissal.evidence_key));
    return insights;
}

const LABELS: Partial<Record<Insight["type"], [label: string, evidence: string]>> = { cash_shortfall: ["Shortfall", "forecast"], budget_pressure: ["Budget", "budget"],
  unusual_activity: ["Unusual", "transaction"], spending_changes: ["Spending", "transactions"], recurring_changes: ["Recurring", "evidence"] };

// Wording is cached per finding set: keys hash the evidence, so the model runs again only when the facts change.
const cachedWording = unstable_cache(async (_workspaceId: string, modelId: string, findings: Pick<Insight, "key" | "type" | "title" | "detail">[]) =>
  Object.fromEntries(await rephraseFindings(getModel(modelId), findings)), ["weekly-briefing-wording", "v2"], { revalidate: 7 * 86400 });

async function wording(props: InsightPanelProps, findings: Insight[]) {
  try {
    requireAiScope(props.settings, "transactions", "planning");
    const sentences = await cachedWording(props.workspaceId, modelIdFor(props.settings, "agents"), findings.map(({ key, type, title, detail }) => ({ key, type, title, detail })));
    return new Map(findings.flatMap(finding => sentences[finding.key] && keepsFacts(finding, sentences[finding.key]) ? [[finding.key, sentences[finding.key]]] : []));
  } catch { return new Map<string, string>(); }
}

/** Home's weekly briefing: only findings worth interrupting for, in AI wording checked against the code-computed facts. Hidden when nothing is big. */
export async function WeeklyBriefing(props: InsightPanelProps) {
  let findings: Insight[];
  try { findings = briefingFindings(await loadInsights(props)); } catch { return null; }
  if (!findings.length) return null;
  const sentences = await wording(props, findings);
  const types = [...new Set(findings.map(finding => finding.type))];
  const action = "rounded-lg border border-input px-2.5 py-1 text-xs hover:bg-muted";
  return <section aria-labelledby="home-briefing" className={card}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="home-briefing" className="flex items-center gap-2 text-sm font-medium"><Sparkle className="size-3.5 fill-current text-ai" aria-hidden="true" />Weekly briefing</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{sentences.size ? "Insight writer · " : ""}from {findings.length} verified finding{findings.length === 1 ? "" : "s"}</p></div>
      <div className="flex items-center gap-2">
        <details className="relative"><summary className={`${action} cursor-pointer list-none`}>Mute type</summary>
          <div className="absolute right-0 z-10 mt-1 flex min-w-40 flex-col rounded-lg border border-border bg-card p-1 shadow-lg">{types.map(type => <form key={type} action={muteInsightType}><input type="hidden" name="type" value={type} /><button className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted">{LABELS[type]?.[0] ?? type}</button></form>)}</div></details>
        <form action={dismissInsights}>{findings.map(finding => <span key={finding.key}><input type="hidden" name="key" value={finding.key} /><input type="hidden" name="type" value={finding.type} /></span>)}<button className={action}>Dismiss all</button></form>
      </div>
    </div>
    <ul className="mt-4 divide-y divide-border border-t border-border">{findings.map((finding, index) => <li key={finding.key} className="grid gap-x-6 gap-y-2 py-4 sm:grid-cols-[8rem_1fr]">
      <p className={`font-mono text-[11px] uppercase tracking-wide ${finding.type === "cash_shortfall" ? "text-warning" : "text-muted-foreground"}`}>{LABELS[finding.type]?.[0] ?? finding.type}</p>
      <div className="min-w-0">
        <p className="text-[15px] leading-relaxed text-pretty" title={finding.detail}>{sentences.get(finding.key) ?? plainWording(finding, props.settings.locale)}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Link href={finding.href} className="ai-chip font-mono">E{index + 1} · {LABELS[finding.type]?.[1] ?? "evidence"}</Link>
          {finding.move && <Link href={`/plan?${new URLSearchParams({ account: finding.move.toAccountId, fundingFrom: finding.move.fromAccountId, fundingDate: finding.move.date, funding: formatInputAmount(finding.move.amountMinor, props.currency) })}#account-headroom`}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90">Preview move</Link>}
          {sourceCoverageNeedsReview(finding.sourceCoverage) && <span className="text-xs text-muted-foreground">Sources incomplete</span>}
          <form action={dismissInsight}><input type="hidden" name="key" value={finding.key} /><input type="hidden" name="type" value={finding.type} /><button className="text-xs text-muted-foreground hover:text-foreground hover:underline" aria-label={`Dismiss ${finding.title}`}>Dismiss</button></form>
        </div>
      </div>
    </li>)}</ul>
  </section>;
}
