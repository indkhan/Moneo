import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { monthPrefix, nextMonthStart, budgetProgress, type MonthlyLimit, type SpendingPlanTransaction } from "@/lib/finance/spending-plans";
import { buildSourceCoverage, loadSourceCoverageMetadata } from "@/lib/finance/source-coverage";
import { SourceCoverageDetails } from "@/app/source-coverage";
import { z } from "zod";
import { formatMoney } from "@/lib/finance/format";
import { saveSpendingPlan, setRollover, toggleSpendingPlan } from "./actions";
import { PlanningHistory } from "../history";

export default async function SpendingPlansPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const currentMonth = monthPrefix(new Date(), workspace.timezone);
  const params = await searchParams;
  const month = params.month ? z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(params.month) : currentMonth;
  const from = `${month}-01`;
  const next = nextMonthStart(month);

  const [categoriesResult, plansResult] = await Promise.all([
    supabase.from("categories").select("id, name").eq("workspace_id", workspace.id).order("name"),
    supabase.from("spending_plans").select("id, category_id, currency_code, limit_minor::text, enabled, version, rollover, rollover_from")
      .eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
  ]);
  if (categoriesResult.error || plansResult.error) throw categoriesResult.error ?? plansResult.error;
  const categories = categoriesResult.data, plans = plansResult.data;

  const earliest = (plans ?? []).filter(plan => plan.rollover).map(plan => plan.rollover_from.slice(0, 7)).sort()[0];
  const historyFrom = earliest && earliest < month ? `${earliest}-01` : from;
  const limitHistory: (MonthlyLimit & { plan_id: string })[] = [];
  for (let offset = 0; ; offset += 500) {
    const history = await supabase.from("spending_plan_limits").select("plan_id, limit_minor::text, enabled, version, effective_month").eq("workspace_id", workspace.id).lte("effective_month", from).order("effective_month").order("id").range(offset, offset + 499);
    if (history.error) throw history.error;
    limitHistory.push(...history.data);
    if (history.data.length < 500) break;
  }
  const rows: SpendingPlanTransaction[] = [];
  const coverageRows: Parameters<typeof buildSourceCoverage>[1] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from("effective_transactions")
      .select("account_id, amount_minor::text, currency_code, status, kind, category_id, posted_on, refund_of_id, review_reasons")
      .eq("workspace_id", workspace.id).gte("posted_on", historyFrom).lt("posted_on", next)
      .order("id").range(offset, offset + 999);
    if (error) throw error;
    coverageRows.push(...(data ?? []));
    rows.push(...(data ?? []).map(item => ({
      amountMinor: BigInt(item.amount_minor),
      currencyCode: item.currency_code,
      status: item.status,
      kind: item.kind,
      reviewReasons: item.review_reasons,
      categoryId: item.category_id,
      postedOn: String(item.posted_on).slice(0, 10),
      refundOfId: (item as { refund_of_id?: string | null }).refund_of_id ?? null,
    } as SpendingPlanTransaction & { refundOfId: string | null })));
    if (!data || data.length < 1000) break;
  }

  const refundIds = [...new Set(rows
    .filter(item => (item as unknown as { refundOfId?: string | null }).refundOfId)
    .map(item => (item as unknown as { refundOfId: string }).refundOfId))];
  const originals = new Map<string, { categoryId: string | null; currencyCode: string }>();
  for (let offset = 0; offset < refundIds.length; offset += 100) {
    const { data, error } = await supabase.from("transactions").select("id, category_id, currency_code")
      .eq("workspace_id", workspace.id).in("id", refundIds.slice(offset, offset + 100));
    if (error) throw error;
    for (const item of data ?? []) originals.set(item.id, { categoryId: item.category_id, currencyCode: item.currency_code });
  }
  for (const item of rows) {
    const refundOfId = (item as unknown as { refundOfId?: string | null }).refundOfId;
    if (item.kind === "refund" && refundOfId) {
      const original = originals.get(refundOfId);
      item.refundOfCategoryId = original?.categoryId ?? null;
      item.refundOfCurrencyCode = original?.currencyCode ?? null;
    }
  }

  const sourceMetadata = await loadSourceCoverageMetadata(supabase, workspace.id, true);
  const to = new Date(Date.parse(`${next}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const names = new Map((categories ?? []).map(item => [item.id, item.name]));
  const progress = (plans ?? []).map(plan => {
    const history = limitHistory.filter(item => item.plan_id === plan.id).sort((a, b) => a.effective_month.localeCompare(b.effective_month) || a.version - b.version);
    const known = history.at(-1);
    const limit = month === currentMonth ? BigInt(plan.limit_minor) : known ? BigInt(known.limit_minor) : null;
    const sourceCoverage = buildSourceCoverage({ from: plan.rollover ? plan.rollover_from : from, to, currencyCode: plan.currency_code }, coverageRows, sourceMetadata?.imports, sourceMetadata?.sources);
    const result = budgetProgress(rows, plan.category_id, plan.currency_code, month, limit, plan.rollover ? { startsMonth: plan.rollover_from.slice(0, 7), history } : undefined, sourceCoverage);
    return { ...plan, sourceCoverage, periodEnabled: month === currentMonth ? plan.enabled : known?.enabled ?? null, spent: result.spentMinor, limit, rolloverResult: result.rolloverResult, remaining: result.remainingMinor, partial: result.partial, limitation: result.limitation };

  });

  return <main className="mx-auto max-w-7xl space-y-7 px-4 py-8 text-foreground sm:px-6 lg:px-10">
    <header>
      <Link href="/plan" className="text-sm text-muted-foreground">← Plan</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Monthly spending plans</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
        Targets for {month}, not predictions. Posted ordinary spending, net of linked refunds;
        transfers, pending and income are excluded. Plans never change account balances and are separate from goal reservations.
      </p>
      <form method="get" className="mt-4 flex flex-wrap items-end gap-2"><label className="grid gap-1 text-sm">Calendar month<input type="month" name="month" defaultValue={month} required className="rounded border border-border bg-card px-3 py-2" /></label><button className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">View month</button></form><p className="mt-2 text-xs text-muted-foreground">Edits below apply to the current calendar month ({currentMonth}). Past targets use recorded history; missing historical targets remain unknown.</p>
    </header>
    {rows.some(row => row.status === "posted" && row.reviewReasons?.length) && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">Partial spending: {rows.filter(row => row.status === "posted" && row.reviewReasons?.length).length} transactions await financial classification. <Link href="/import" className="underline">Review import evidence</Link></p>}
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-lg font-semibold">Plans</h2>
      {!progress.length && <p className="mt-3 text-muted-foreground">No spending plans yet. Set one below.</p>}
      <ul className="mt-4 grid gap-3 lg:grid-cols-2">{progress.map(plan => (
        <li key={`${plan.id}:${plan.version}`} className="rounded-lg border border-border bg-muted/35 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium">{names.get(plan.category_id) ?? "Unknown category"}{plan.periodEnabled === false ? " (disabled that month)" : ""}</h3>
            <p className="font-mono text-sm text-muted-foreground">{formatMoney(plan.spent, plan.currency_code, workspace.locale)} of {plan.limit === null ? "Unknown historical target" : formatMoney(plan.limit, plan.currency_code, workspace.locale)}</p>
          </div>
          <p className="mt-2 font-mono text-sm font-medium">{plan.periodEnabled !== false
            ? (plan.partial ? plan.limitation : plan.remaining === null ? "Historical target unavailable" : plan.remaining >= 0n ? `${formatMoney(plan.remaining, plan.currency_code, workspace.locale)} left in accepted records` : `${formatMoney(-plan.remaining, plan.currency_code, workspace.locale)} over plan in accepted records`)
            : "Disabled: not counted as an active target."}</p>
          {plan.partial && <p className="mt-2 text-xs text-muted-foreground">Classified spending shown; remaining budget is unknown. {plan.limitation?.includes("classification") && <Link href="/import" className="text-brand underline">Review classifications</Link>}</p>}
          <SourceCoverageDetails coverage={plan.sourceCoverage} />
          {plan.periodEnabled === true && plan.limit !== null && !plan.partial && <progress className="mt-3 h-1.5 w-full accent-brand" max={Number(plan.limit)} value={Math.max(0, Number(plan.spent))} aria-label={`${names.get(plan.category_id) ?? "Category"} plan used`} />}
          {plan.rolloverResult?.status === "available" && <p className="mt-2 text-xs text-muted-foreground">Accepted-record carry from earlier months: {formatMoney(plan.rolloverResult.carriedMinor, plan.currency_code, workspace.locale)}. Accepted-record allowance: {formatMoney(plan.rolloverResult.allowanceMinor, plan.currency_code, workspace.locale)}.</p>}
          <form action={setRollover} className="mt-3 flex flex-wrap items-end gap-3 text-sm"><input type="hidden" name="planId" value={plan.id} /><input type="hidden" name="version" value={plan.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><label className="flex gap-2"><input type="checkbox" name="rollover" defaultChecked={plan.rollover} />Carry remaining budget into the next month</label><label className="grid gap-1 text-xs">Rollover starts<input type="month" name="rolloverFrom" required defaultValue={plan.rollover_from.slice(0, 7)} className="rounded border border-border bg-card px-3 py-2" /></label><button className="text-brand underline">Save rollover rule</button><p className="w-full text-xs text-muted-foreground">Positive and negative remainders carry; disabled months reset carry. Each month uses its recorded target. Missing history or uncertain classifications make carry unavailable. Budgets never add a second forecast expense.</p></form>
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={saveSpendingPlan} className="flex flex-wrap gap-2">
              <input type="hidden" name="planId" value={plan.id} /><input type="hidden" name="version" value={plan.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} />
              <input type="hidden" name="categoryId" value={plan.category_id} />
              <input type="hidden" name="currency" value={plan.currency_code} />
              <input name="amount" required aria-label={`Edit ${names.get(plan.category_id) ?? "plan"} limit`} placeholder="0.00" className="min-h-10 w-28 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
              <button className="font-medium text-brand hover:underline">Update limit</button>
            </form>
            <form action={toggleSpendingPlan}>
              <input type="hidden" name="planId" value={plan.id} />
              <input type="hidden" name="version" value={plan.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} />
              <input type="hidden" name="enabled" value={plan.enabled ? "false" : "true"} />
              <button className="font-medium text-brand hover:underline">{plan.enabled ? "Disable" : "Enable"}</button>
            </form>
          </div>
        </li>))}</ul>
    </section>
    {!!categories?.length && (
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Set a monthly limit</h2>
        <form action={saveSpendingPlan} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">Category
            <select name="categoryId" aria-label="Category" className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15">
              {categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Currency
            <input name="currency" defaultValue={workspace.display_currency} required maxLength={3} aria-label="Currency code" className="min-h-10 w-20 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
          </label>
          <label className="grid gap-1 text-sm">Monthly limit
            <input name="amount" required placeholder="400.00" aria-label="Monthly limit" className="min-h-10 w-32 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
          </label>
          <button className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Save plan</button>
        </form>
      </section>
    )}
    <PlanningHistory entityType="spending_plan" destination="/plan/spending" />
  </main>;
}
