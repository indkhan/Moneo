import Link from "next/link";
import { CurrencySelect } from "@/components/currency-select";
import { SafeForm } from "@/components/safe-form";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { allPages } from "@/lib/all-pages";
import { monthPrefix, nextMonthStart, budgetProgress, type MonthlyLimit, type SpendingPlanTransaction } from "@/lib/finance/spending-plans";
import { buildSourceCoverage, loadSourceCoverageMetadata } from "@/lib/finance/source-coverage";
import { SourceCoverageDetails } from "@/app/source-coverage";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { saveSpendingPlanSafely, setRolloverSafely, toggleSpendingPlanSafely } from "./actions";
import { MonthPicker } from "./month-picker";
import { PlanningHistory } from "../history";
import { button, card, field, linkButton, percentOf } from "../ui";

export const metadata = { title: "Spending limits" };

/** Why a limit's remaining amount is unknown, and where to fix it. */
function partialReason(limitation: string | null) {
  if (limitation === "Historical target unavailable") return { text: "No limit was recorded for this month, so the amount left is unknown." };
  if (limitation?.includes("classification")) return { text: "Only classified spending is shown, so the amount left is unknown.", href: "/import", action: "Review classifications" };
  if (limitation?.includes("coverage")) return { text: "Your imports may not cover this whole period, so the amount left is unknown.", href: "/import", action: "Review imports" };
  return { text: "The carry-over from earlier months could not be worked out, so the amount left is unknown." };
}

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
  type Row = { account_id: string; amount_minor: string; currency_code: string; status: string; kind: string; category_id: string | null; posted_on: string; refund_of_id: string | null; review_reasons: string[] };
  const coverageRows = await allPages<Row>((start, end, count) => supabase.from("effective_transactions")
    .select("account_id, amount_minor::text, currency_code, status, kind, category_id, posted_on, refund_of_id, review_reasons", count ? { count } : undefined)
    .eq("workspace_id", workspaceId).gte("posted_on", from).lt("posted_on", before).order("id").range(start, end), 1000);
  const rows: (SpendingPlanTransaction & { refundOfId: string | null })[] = coverageRows.map(item => ({ amountMinor: BigInt(item.amount_minor), currencyCode: item.currency_code, status: item.status, kind: item.kind, reviewReasons: item.review_reasons,
    categoryId: item.category_id, postedOn: String(item.posted_on).slice(0, 10), refundOfId: item.refund_of_id ?? null }));
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
  const requestedMonth = z.string().regex(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/).safeParse(params.month);
  const invalidMonth = !!params.month && !requestedMonth.success;
  const month = requestedMonth.success ? requestedMonth.data : currentMonth;
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
  // Rollover loads earlier months too; this count is about the month on screen.
  const needsReview = rows.filter(row => row.status === "posted" && row.reviewReasons?.length && row.postedOn >= from && row.postedOn < next).length;
  const monthName = (value: string) => new Intl.DateTimeFormat(workspace.locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T00:00:00Z`));

  return <main className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 text-foreground sm:px-8 lg:py-8">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="eyebrow"><Link href="/plan" className="hover:text-foreground">Plan</Link> · {monthName(month)}</p>
        <h1 className="mt-1 page-title">Spending limits</h1>
        <p className="mt-2 text-sm text-muted-foreground">Monthly category limits for {monthName(month)}. Counts posted spending minus refunds; transfers, pending items and income are left out.</p></div>
      <MonthPicker month={month} className={field} />
    </header>
    {invalidMonth && <p role="alert" className="text-sm">That link has an invalid month, so this is the current month.</p>}
    {month !== currentMonth && <p role="status" className="rounded-lg bg-muted/60 px-4 py-3 text-sm">Viewing {month > currentMonth ? "a future" : "a past"} month. Changes apply to {monthName(currentMonth)}, and saving takes you back there.</p>}
    {needsReview > 0 && <p role="status" className="text-sm text-warning">Some spending in {monthName(month)} is not counted yet: {needsReview} transactions need review. <Link href="/import" className="underline">Review imports</Link></p>}
    {progress.length > 0 && <section className={card} aria-labelledby="limits-heading">
      <h2 id="limits-heading" className="text-sm font-medium">Category limits</h2>
      <ul className="divide-y divide-border">{progress.map(plan => {
        const money = (amount: bigint) => formatMoney(amount, plan.currency_code, workspace.locale);
        const cap = plan.allowance ?? plan.limit;
        const over = plan.remaining !== null && plan.remaining < 0n;
        return <li key={`${plan.id}:${plan.version}`} className="space-y-2 py-4 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium">{plan.name}{plan.periodEnabled === false ? " (disabled that month)" : ""}</h3>
            <p className="font-mono text-sm text-muted-foreground">{money(plan.spent)} of {cap === null ? "Unknown historical target" : money(cap)}</p>
          </div>
          {plan.periodEnabled !== false && cap !== null && cap > 0n && <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${plan.name} limit used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentOf(plan.spent, cap)} aria-valuetext={`${money(plan.spent)} spent of ${money(cap)}`}>
            <div className={`h-full rounded-full ${over ? "bg-foreground" : plan.partial ? "bg-muted-foreground" : "bg-brand"}`} style={{ width: `${percentOf(plan.spent, cap)}%` }} /></div>}
          <p className={`font-mono text-sm ${over ? "font-semibold" : "font-medium"}`}>{plan.periodEnabled !== false
            ? (plan.partial ? plan.limitation : plan.remaining === null ? "Historical target unavailable" : plan.remaining >= 0n ? `${money(plan.remaining)} left${plan.spent === 0n ? ", nothing spent yet" : ""}` : `${money(-plan.remaining)} over plan`)
            : "Disabled: not counted as a target."}</p>
          {plan.partial && (() => { const reason = partialReason(plan.limitation); return <p className="text-sm text-muted-foreground">{reason.text} {reason.href && <Link href={reason.href} className="text-brand underline">{reason.action}</Link>}</p>; })()}
          {plan.rolloverResult?.status === "available" && <p className="text-sm text-muted-foreground">{plan.limit !== null && `Monthly limit: ${money(plan.limit)}. `}Carried over: {money(plan.rolloverResult.carriedMinor)}. Total allowance: {money(plan.rolloverResult.allowanceMinor)}.</p>}
          <SourceCoverageDetails coverage={plan.sourceCoverage} />
          <details><summary className="cursor-pointer text-sm underline">Edit limit and rollover</summary>
            <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-3">
              <SafeForm action={saveSpendingPlanSafely} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="planId" value={plan.id} /><input type="hidden" name="version" value={plan.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} />
                <input type="hidden" name="categoryId" value={plan.category_id} /><input type="hidden" name="currency" value={plan.currency_code} />
                <label className="grid gap-1 text-sm">Monthly limit for {monthName(currentMonth)} ({plan.currency_code})<input name="amount" required inputMode="decimal" defaultValue={formatInputAmount(plan.limit_minor, plan.currency_code)} className={field + " w-28"} /></label>
                <button aria-label={`Update ${plan.name} limit`} className={linkButton}>Update limit</button>
              </SafeForm>
              <SafeForm action={toggleSpendingPlanSafely}><input type="hidden" name="planId" value={plan.id} /><input type="hidden" name="version" value={plan.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><input type="hidden" name="enabled" value={plan.enabled ? "false" : "true"} /><button aria-label={`${plan.enabled ? "Disable" : "Enable"} ${plan.name}`} className={linkButton}>{plan.enabled ? "Disable" : "Enable"}</button></SafeForm>
              <SafeForm action={setRolloverSafely} className="flex w-full flex-wrap items-end gap-3 text-sm"><input type="hidden" name="planId" value={plan.id} /><input type="hidden" name="version" value={plan.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><label className="flex gap-2"><input type="checkbox" name="rollover" defaultChecked={plan.rollover} />Carry remaining budget into the next month</label><label className="grid gap-1 text-xs">Rollover starts<input type="month" name="rolloverFrom" required defaultValue={plan.rollover_from.slice(0, 7)} className={field} /></label><button className={linkButton}>Save rollover rule</button><p className="w-full text-sm text-muted-foreground">Leftover and overspent amounts both carry over. Disabled months reset the carry.</p></SafeForm>
            </div>
          </details>
        </li>;
      })}</ul>
    </section>}
    {!categories.length && <section className={card}><h2 className="text-sm font-medium">Create your first spending limit</h2><p className="text-sm text-muted-foreground">A limit belongs to a category, and you have none yet. <Link href="/money/organization" className="text-brand underline">Organize your transactions</Link> to set them up.</p></section>}
    {!!categories.length && <section className={card} aria-labelledby="new-limit-heading">
      <h2 id="new-limit-heading" className="text-sm font-medium">{progress.length ? "Set a monthly limit" : "Create your first spending limit"}</h2>
      <p className="text-sm text-muted-foreground">A limit is a target for a category. It reserves nothing and moves no money.</p>
      <SafeForm action={saveSpendingPlanSafely} className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm font-medium">Category<select name="categoryId" aria-label="Category" className={field}>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Currency<CurrencySelect name="currency" label="Currency" defaultValue={workspace.display_currency} locale={workspace.locale} /></label>
        <label className="grid gap-1 text-sm">Monthly limit<input name="amount" required inputMode="decimal" placeholder="400.00" aria-label="Monthly limit" className={field + " w-32"} /></label>
        <button className={button}>Set limit</button>
        <p className="basis-full text-xs text-muted-foreground">Enter the amount with a dot for decimals, like 400.00.</p>
      </SafeForm>
    </section>}
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading history…</p>}><PlanningHistory entityType="spending_plan" destination="/plan/spending" categories={names} /></Suspense>
  </main>;
}
