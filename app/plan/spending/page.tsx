import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { monthPrefix, nextMonthStart, budgetProgress, type MonthlyLimit, type SpendingPlanTransaction } from "@/lib/finance/spending-plans";
import { buildSourceCoverage, loadSourceCoverageMetadata } from "@/lib/finance/source-coverage";
import { SourceCoverageDetails } from "@/app/source-coverage";
import { formatMoney } from "@/lib/finance/format";
import { saveSpendingPlan, setRollover, toggleSpendingPlan } from "./actions";
import { PlanningHistory } from "../history";
import { button, card, field, linkButton, percentOf } from "../ui";

type Db = Awaited<ReturnType<typeof requireWorkspace>>["supabase"];

async function loadLimitHistory(supabase: Db, workspaceId: string, from: string) {
  const rows: (MonthlyLimit & { plan_id: string })[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await supabase.from("spending_plan_limits").select("plan_id, limit_minor::text, enabled, version, effective_month").eq("workspace_id", workspaceId).lte("effective_month", from).order("effective_month").order("id").range(offset, offset + 499);
    if (page.error) throw page.error;
    rows.push(...page.data);
    if (page.data.length < 500) return rows;
  }
}

async function loadSpending(supabase: Db, workspaceId: string, from: string, before: string) {
  const coverageRows: Parameters<typeof buildSourceCoverage>[1] = [];
  const rows: (SpendingPlanTransaction & { refundOfId: string | null })[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from("effective_transactions")
      .select("account_id, amount_minor::text, currency_code, status, kind, category_id, posted_on, refund_of_id, review_reasons")
      .eq("workspace_id", workspaceId).gte("posted_on", from).lt("posted_on", before).order("id").range(offset, offset + 999);
    if (error) throw error;
    coverageRows.push(...(data ?? []));
    rows.push(...(data ?? []).map(item => ({ amountMinor: BigInt(item.amount_minor), currencyCode: item.currency_code, status: item.status, kind: item.kind, reviewReasons: item.review_reasons,
      categoryId: item.category_id, postedOn: String(item.posted_on).slice(0, 10), refundOfId: item.refund_of_id ?? null })));
    if (!data || data.length < 1000) break;
  }
  // Linked refunds count against the original purchase's category; batch the lookups in parallel.
  const refundIds = [...new Set(rows.flatMap(row => row.kind === "refund" && row.refundOfId ? [row.refundOfId] : []))];
  const batches = await Promise.all(Array.from({ length: Math.ceil(refundIds.length / 100) }, (_, index) =>
    supabase.from("transactions").select("id, category_id, currency_code").eq("workspace_id", workspaceId).in("id", refundIds.slice(index * 100, index * 100 + 100))));
  const originals = new Map<string, { category_id: string | null; currency_code: string }>();
  for (const { data, error } of batches) { if (error) throw error; for (const item of data ?? []) originals.set(item.id, item); }
  for (const row of rows) if (row.kind === "refund" && row.refundOfId) {
    const original = originals.get(row.refundOfId);
    row.refundOfCategoryId = original?.category_id ?? null;
    row.refundOfCurrencyCode = original?.currency_code ?? null;
  }
  return { rows, coverageRows };
}

export default async function SpendingPlansPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const currentMonth = monthPrefix(new Date(), workspace.timezone);
  const params = await searchParams;
  const month = params.month ? z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(params.month) : currentMonth;
  const from = `${month}-01`;
  const next = nextMonthStart(month);

  const [categoriesResult, plansResult, limitHistory, sourceMetadata] = await Promise.all([
    supabase.from("categories").select("id, name").eq("workspace_id", workspace.id).order("name"),
    supabase.from("spending_plans").select("id, category_id, currency_code, limit_minor::text, enabled, version, rollover, rollover_from")
      .eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
    loadLimitHistory(supabase, workspace.id, from),
    loadSourceCoverageMetadata(supabase, workspace.id, true),
  ]);
  if (categoriesResult.error || plansResult.error) throw categoriesResult.error ?? plansResult.error;
  const categories = categoriesResult.data ?? [], plans = plansResult.data ?? [];
  const earliest = plans.filter(plan => plan.rollover).map(plan => plan.rollover_from.slice(0, 7)).sort()[0];
  const { rows, coverageRows } = await loadSpending(supabase, workspace.id, earliest && earliest < month ? `${earliest}-01` : from, next);

  const to = new Date(Date.parse(`${next}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const names = new Map(categories.map(item => [item.id, item.name]));
  const progress = plans.map(plan => {
    const history = limitHistory.filter(item => item.plan_id === plan.id).sort((a, b) => a.effective_month.localeCompare(b.effective_month) || a.version - b.version);
    const known = history.at(-1);
    const limit = month === currentMonth ? BigInt(plan.limit_minor) : known ? BigInt(known.limit_minor) : null;
    const sourceCoverage = buildSourceCoverage({ from: plan.rollover ? plan.rollover_from : from, to, currencyCode: plan.currency_code }, coverageRows, sourceMetadata?.imports, sourceMetadata?.sources);
    const result = budgetProgress(rows, plan.category_id, plan.currency_code, month, limit, plan.rollover ? { startsMonth: plan.rollover_from.slice(0, 7), history } : undefined, sourceCoverage);
    return { ...plan, name: names.get(plan.category_id) ?? "Unknown category", sourceCoverage, periodEnabled: month === currentMonth ? plan.enabled : known?.enabled ?? null, spent: result.spentMinor, limit,
      allowance: result.allowanceMinor, rolloverResult: result.rolloverResult, remaining: result.remainingMinor, partial: result.partial, limitation: result.limitation };
  });
  const needsReview = rows.filter(row => row.status === "posted" && row.reviewReasons?.length).length;

  return <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 text-foreground sm:px-8 lg:py-10">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><Link href="/plan" className="text-sm text-muted-foreground hover:text-foreground">← Plan</Link>
        <h1 className="mt-2 page-title">Spending limits</h1>
        <p className="mt-2 text-sm text-muted-foreground">Monthly category limits for {month}. Counts posted spending minus refunds; transfers, pending items and income are left out.</p></div>
      <form method="get" className="flex flex-wrap items-end gap-2"><label className="grid gap-1 text-xs font-medium text-muted-foreground">Calendar month<input type="month" name="month" defaultValue={month} required className={field} /></label><button className={button}>View month</button></form>
    </header>
    {month !== currentMonth && <p className="text-sm text-muted-foreground">Viewing a past month. Edits apply to the current month ({currentMonth}).</p>}
    {needsReview > 0 && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">Some spending is not counted yet: {needsReview} transactions need review. <Link href="/import" className="underline">Review imports</Link></p>}
    <section className={card} aria-labelledby="limits-heading">
      <h2 id="limits-heading" className="text-sm font-medium">Category limits</h2>
      {!progress.length && <p className="text-muted-foreground">No spending limits yet. Set one below.</p>}
      <ul className="divide-y divide-border">{progress.map(plan => {
        const money = (amount: bigint) => formatMoney(amount, plan.currency_code, workspace.locale);
        const cap = plan.allowance ?? plan.limit;
        const over = plan.remaining !== null && plan.remaining < 0n;
        return <li key={`${plan.id}:${plan.version}`} className="space-y-2 py-4 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium">{plan.name}{plan.periodEnabled === false ? " (disabled that month)" : ""}</h3>
            <p className="font-mono text-sm text-muted-foreground">{money(plan.spent)} of {plan.limit === null ? "Unknown historical target" : money(plan.limit)}</p>
          </div>
          {plan.periodEnabled !== false && cap !== null && cap > 0n && <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${plan.name} plan used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentOf(plan.spent, cap)}>
            <div className={`h-full rounded-full ${over ? "bg-foreground" : plan.partial ? "bg-muted-foreground" : "bg-brand"}`} style={{ width: `${percentOf(plan.spent, cap)}%` }} /></div>}
          <p className={`font-mono text-sm ${over ? "font-semibold" : "font-medium"}`}>{plan.periodEnabled !== false
            ? (plan.partial ? plan.limitation : plan.remaining === null ? "Historical target unavailable" : plan.remaining >= 0n ? `${money(plan.remaining)} left` : `${money(-plan.remaining)} over plan`)
            : "Disabled: not counted as a target."}</p>
          {plan.partial && <p className="text-sm text-muted-foreground">Only classified spending is shown, so the amount left is unknown. {plan.limitation?.includes("classification") && <Link href="/import" className="text-brand underline">Review classifications</Link>}</p>}
          {plan.rolloverResult?.status === "available" && <p className="text-sm text-muted-foreground">Carried over: {money(plan.rolloverResult.carriedMinor)}. Total allowance: {money(plan.rolloverResult.allowanceMinor)}.</p>}
          <SourceCoverageDetails coverage={plan.sourceCoverage} />
          <details><summary className="cursor-pointer text-sm underline">Edit limit and rollover</summary>
            <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-3">
              <form action={saveSpendingPlan} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="planId" value={plan.id} /><input type="hidden" name="version" value={plan.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} />
                <input type="hidden" name="categoryId" value={plan.category_id} /><input type="hidden" name="currency" value={plan.currency_code} />
                <input name="amount" required inputMode="decimal" aria-label={`Edit ${plan.name} limit`} placeholder="0.00" className={field + " w-28"} />
                <button className={linkButton}>Update limit</button>
              </form>
              <form action={toggleSpendingPlan}><input type="hidden" name="planId" value={plan.id} /><input type="hidden" name="version" value={plan.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><input type="hidden" name="enabled" value={plan.enabled ? "false" : "true"} /><button className={linkButton}>{plan.enabled ? "Disable" : "Enable"}</button></form>
              <form action={setRollover} className="flex w-full flex-wrap items-end gap-3 text-sm"><input type="hidden" name="planId" value={plan.id} /><input type="hidden" name="version" value={plan.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><label className="flex gap-2"><input type="checkbox" name="rollover" defaultChecked={plan.rollover} />Carry remaining budget into the next month</label><label className="grid gap-1 text-xs">Rollover starts<input type="month" name="rolloverFrom" required defaultValue={plan.rollover_from.slice(0, 7)} className={field} /></label><button className={linkButton}>Save rollover rule</button><p className="w-full text-sm text-muted-foreground">Leftover and overspent amounts both carry over. Disabled months reset the carry.</p></form>
            </div>
          </details>
        </li>;
      })}</ul>
    </section>
    {!!categories.length && <section className={card} aria-labelledby="new-limit-heading">
      <h2 id="new-limit-heading" className="text-sm font-medium">Set a monthly limit</h2>
      <form action={saveSpendingPlan} className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm font-medium">Category<select name="categoryId" aria-label="Category" className={field}>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Currency<input name="currency" defaultValue={workspace.display_currency} required maxLength={3} aria-label="Currency code" className={field + " w-20"} /></label>
        <label className="grid gap-1 text-sm">Monthly limit<input name="amount" required inputMode="decimal" placeholder="400.00" aria-label="Monthly limit" className={field + " w-32"} /></label>
        <button className={button}>Save plan</button>
      </form>
    </section>}
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading history…</p>}><PlanningHistory entityType="spending_plan" destination="/plan/spending" /></Suspense>
  </main>;
}
