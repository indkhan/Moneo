import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { monthPrefix, nextMonthStart, spendingForCategory, type SpendingPlanTransaction } from "@/lib/finance/spending-plans";
import { formatMoney } from "@/lib/finance/format";
import { saveSpendingPlan, toggleSpendingPlan } from "./actions";

export default async function SpendingPlansPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const month = monthPrefix();
  const from = `${month}-01`;
  const next = nextMonthStart(month);

  const [{ data: categories }, { data: plans }] = await Promise.all([
    supabase.from("categories").select("id, name").eq("workspace_id", workspace.id).order("name"),
    supabase.from("spending_plans").select("id, category_id, currency_code, limit_minor, enabled")
      .eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
  ]);

  const rows: SpendingPlanTransaction[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from("transactions")
      .select("amount_minor, currency_code, status, kind, category_id, posted_on, refund_of_id")
      .eq("workspace_id", workspace.id).gte("posted_on", from).lt("posted_on", next)
      .order("id").range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data ?? []).map(item => ({
      amountMinor: BigInt(item.amount_minor),
      currencyCode: item.currency_code,
      status: item.status,
      kind: item.kind,
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
  if (refundIds.length) {
    const { data, error } = await supabase.from("transactions").select("id, category_id, currency_code")
      .eq("workspace_id", workspace.id).in("id", refundIds);
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

  const names = new Map((categories ?? []).map(item => [item.id, item.name]));
  const progress = (plans ?? []).map(plan => {
    const spent = spendingForCategory(rows, plan.category_id, plan.currency_code, month);
    const limit = BigInt(plan.limit_minor);
    return { ...plan, spent, limit, remaining: limit - spent };
  });

  return <main className="mx-auto max-w-7xl space-y-7 px-4 py-8 text-foreground sm:px-6 lg:px-10">
    <header>
      <Link href="/plan" className="text-sm text-muted-foreground">← Plan</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Monthly spending plans</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
        Targets for {month}, not predictions. Current-month posted ordinary spending, net of linked refunds;
        transfers, pending and income are excluded. Plans never change account balances and are separate from goal reservations.
      </p>
    </header>
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-lg font-semibold">Plans</h2>
      {!progress.length && <p className="mt-3 text-muted-foreground">No spending plans yet. Set one below.</p>}
      <ul className="mt-4 grid gap-3 lg:grid-cols-2">{progress.map(plan => (
        <li key={plan.id} className="rounded-lg border border-border bg-muted/35 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium">{names.get(plan.category_id) ?? "Unknown category"}{plan.enabled ? "" : " (disabled)"}</h3>
            <p className="font-mono text-sm text-muted-foreground">{formatMoney(plan.spent, plan.currency_code)} of {formatMoney(plan.limit, plan.currency_code)}</p>
          </div>
          <p className="mt-2 font-mono text-sm font-medium">{plan.enabled
            ? (plan.remaining >= 0n ? `${formatMoney(plan.remaining, plan.currency_code)} left` : `${formatMoney(-plan.remaining, plan.currency_code)} over plan`)
            : "Disabled: not counted as an active target."}</p>
          {plan.enabled && <progress className="mt-3 h-1.5 w-full accent-brand" max={Number(plan.limit)} value={Number(plan.spent)} aria-label={`${names.get(plan.category_id) ?? "Category"} plan used`} />}
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={saveSpendingPlan} className="flex flex-wrap gap-2">
              <input type="hidden" name="categoryId" value={plan.category_id} />
              <input type="hidden" name="currency" value={plan.currency_code} />
              <input name="amount" required aria-label={`Edit ${names.get(plan.category_id) ?? "plan"} limit`} placeholder="0.00" className="min-h-10 w-28 rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
              <button className="font-medium text-brand hover:underline">Update limit</button>
            </form>
            <form action={toggleSpendingPlan}>
              <input type="hidden" name="planId" value={plan.id} />
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
            <select name="categoryId" aria-label="Category" className="min-h-10 rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15">
              {categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Currency
            <input name="currency" defaultValue={workspace.display_currency} required maxLength={3} aria-label="Currency code" className="min-h-10 w-20 rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
          </label>
          <label className="grid gap-1 text-sm">Monthly limit
            <input name="amount" required placeholder="400.00" aria-label="Monthly limit" className="min-h-10 w-32 rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
          </label>
          <button className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Save plan</button>
        </form>
      </section>
    )}
  </main>;
}
