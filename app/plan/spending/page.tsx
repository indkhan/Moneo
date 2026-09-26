import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { monthPrefix, spendingForCategory, type SpendingPlanTransaction } from "@/lib/finance/spending-plans";
import { saveSpendingPlan, toggleSpendingPlan } from "./actions";

function money(minor: bigint, currency: string) {
  const abs = minor < 0n ? -minor : minor;
  return `${minor < 0n ? "−" : ""}${currency} ${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export default async function SpendingPlansPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const month = monthPrefix();
  const [year, mon] = month.split("-").map(Number);
  const from = `${month}-01`;
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;

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

  return <main className="mx-auto max-w-3xl space-y-8 px-6 py-10">
    <header>
      <Link href="/plan" className="text-sm text-muted-foreground">← Plan</Link>
      <h1 className="mt-2 text-3xl font-semibold">Monthly spending plans</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Targets for {month}, not predictions. Current-month posted ordinary spending, net of linked refunds;
        transfers, pending and income are excluded. Plans never change account balances and are separate from goal reservations.
      </p>
    </header>
    <section>
      <h2 className="text-xl font-semibold">Plans</h2>
      {!progress.length && <p className="mt-3 text-muted-foreground">No spending plans yet. Set one below.</p>}
      <ul className="mt-4 space-y-3">{progress.map(plan => (
        <li key={plan.id} className="rounded border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium">{names.get(plan.category_id) ?? "Unknown category"}{plan.enabled ? "" : " (disabled)"}</h3>
            <p className="text-sm text-muted-foreground">{money(plan.spent, plan.currency_code)} of {money(plan.limit, plan.currency_code)}</p>
          </div>
          <p className="mt-1 text-sm">{plan.enabled
            ? (plan.remaining >= 0n ? `${money(plan.remaining, plan.currency_code)} left` : `${money(-plan.remaining, plan.currency_code)} over plan`)
            : "Disabled: not counted as an active target."}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={saveSpendingPlan} className="flex flex-wrap gap-2">
              <input type="hidden" name="categoryId" value={plan.category_id} />
              <input type="hidden" name="currency" value={plan.currency_code} />
              <input name="amount" required aria-label={`Edit ${names.get(plan.category_id) ?? "plan"} limit`} placeholder="0.00" className="w-28 rounded border p-2" />
              <button className="underline">Update limit</button>
            </form>
            <form action={toggleSpendingPlan}>
              <input type="hidden" name="planId" value={plan.id} />
              <input type="hidden" name="enabled" value={plan.enabled ? "false" : "true"} />
              <button className="underline">{plan.enabled ? "Disable" : "Enable"}</button>
            </form>
          </div>
        </li>))}</ul>
    </section>
    {!!categories?.length && (
      <section className="rounded-lg border p-5">
        <h2 className="font-semibold">Set a monthly limit</h2>
        <form action={saveSpendingPlan} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">Category
            <select name="categoryId" aria-label="Category" className="rounded border p-2">
              {categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Currency
            <input name="currency" defaultValue={workspace.display_currency} required maxLength={3} aria-label="Currency code" className="w-20 rounded border p-2" />
          </label>
          <label className="grid gap-1 text-sm">Monthly limit
            <input name="amount" required placeholder="400.00" aria-label="Monthly limit" className="w-32 rounded border p-2" />
          </label>
          <button className="rounded bg-primary px-4 py-2 text-primary-foreground">Save plan</button>
        </form>
      </section>
    )}
  </main>;
}
