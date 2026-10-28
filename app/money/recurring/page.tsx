import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { recurringCadences } from "@/lib/finance/cadences";
import { calendarDate } from "@/lib/finance/calendar";
import { expandSchedule } from "@/lib/finance/model";
import { formatInputAmount } from "@/lib/finance/format";
import { formatMoney, monthlyEquivalent } from "./series";
import { addSchedule, deleteSchedule, updateSchedule } from "./actions";
import { ScheduleDialog } from "./forms";
import { DetectedPatterns } from "./detected";
import { OccurrenceReview } from "./occurrences";

type Schedule = { id: string; name: string; category: { name: string } | null; account_id: string | null; amount_minor: string; currency_code: string; cadence: string; starts_on: string; ends_on: string | null; schedule_anchor_on: string | null; source: string };
const UPCOMING_DAYS = 30;

export default async function RecurringPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const money = (amount: string | bigint, currency: string) => formatMoney(amount, currency, workspace.locale);
  const today = calendarDate(new Date(), workspace.timezone);

  const [{ data: accounts, error: accountsError }, { data: scheduleData, error: schedulesError }, { data: categoryData }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency_code, archived_at").eq("workspace_id", workspace.id).order("name"),
    supabase.from("financial_assumptions").select("id, name, category:categories(name), account_id, amount_minor::text, currency_code, cadence, starts_on, ends_on, schedule_anchor_on, source")
      .eq("workspace_id", workspace.id).eq("confirmed", true).eq("enabled", true).is("removed_at", null).in("cadence", recurringCadences).order("name").limit(500),
    supabase.from("categories").select("name").eq("workspace_id", workspace.id).order("name").limit(500),
  ]);
  const categories = (categoryData ?? []).map(row => row.name as string);
  const liveAccounts = (accounts ?? []).filter(account => !account.archived_at).map(account => ({ id: account.id as string, name: account.name as string, currencyCode: account.currency_code as string }));
  const names: Record<string, string> = Object.fromEntries((accounts ?? []).map(account => [account.id, account.name]));

  // Same expansion as the forecast, so "next" here matches Plan. Account-less schedules still get a date.
  const schedules = ((scheduleData ?? []) as unknown as Schedule[]).map(item => {
    const dated = { ...item, account_id: item.account_id ?? "unassigned" };
    const upcoming = expandSchedule(dated, today, UPCOMING_DAYS);
    const amount = BigInt(item.amount_minor);
    return { ...item, amount, next: expandSchedule(dated, today, 400)[0]?.date ?? null, upcoming: amount * BigInt(upcoming.length), monthly: monthlyEquivalent(amount, item.cadence) };
  }).sort((a, b) => (a.next ?? "9999").localeCompare(b.next ?? "9999") || a.name.localeCompare(b.name));
  const totals = new Map<string, { out: bigint; in: bigint; upcoming: bigint }>();
  for (const item of schedules) {
    if (!item.next) continue;
    const total = totals.get(item.currency_code) ?? { out: 0n, in: 0n, upcoming: 0n };
    if (item.monthly < 0n) total.out += item.monthly; else total.in += item.monthly;
    total.upcoming += item.upcoming;
    totals.set(item.currency_code, total);
  }

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 text-foreground sm:px-8 lg:py-8">
      <header className="space-y-4">
        <div className="flex flex-col gap-1">
          <p className="eyebrow">Money · bills, subscriptions, income</p>
          <h1 className="page-title">Recurring payments</h1>
          <p className="mt-1 text-sm text-muted-foreground">Confirmed bills, subscriptions and income. Suggestions below only reach your forecast once you confirm them.</p>
        </div>
        {liveAccounts.length > 0 && <ScheduleDialog title="Add a recurring payment" trigger="Add recurring" submitLabel="Add recurring" action={addSchedule} accounts={liveAccounts} categories={categories}
          triggerClassName="min-h-10 w-fit rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          defaults={{ name: "", amount: "", direction: "out", cadence: "monthly", startsOn: today, category: "" }} />}
      </header>
      {accountsError && <p role="alert">Could not load accounts: {accountsError.message}</p>}

      <section aria-label="Bills and subscriptions" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-sm font-medium">Bills and subscriptions</h2>
          {totals.size > 0 && <dl className="flex flex-wrap gap-x-6 gap-y-1 text-right text-sm">{[...totals].map(([currency, total]) => <div key={currency} className="grid">
            <dt className="text-xs text-muted-foreground">Per month ({currency})</dt>
            <dd className="font-mono font-semibold tabular-nums">{money(total.out, currency)}{total.in > 0n && <span className="ml-2 text-success">+{money(total.in, currency)} in</span>}</dd>
            <dd className="text-xs text-muted-foreground">Next {UPCOMING_DAYS} days: {money(total.upcoming, currency)}</dd>
          </div>)}</dl>}
        </div>
        {schedulesError ? <p role="alert">Could not load confirmed schedules: {schedulesError.message}</p> : schedules.length ? <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground"><tr>
              <th className="px-4 py-2.5 font-medium">Name</th><th className="px-3 py-2.5 font-medium">Category</th><th className="px-3 py-2.5 font-medium">Cadence</th><th className="px-3 py-2.5 font-medium">Next</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
            </tr></thead>
            <tbody className="divide-y divide-border">{schedules.map(item => <tr key={item.id} className={item.next ? "" : "text-muted-foreground"}>
              <td className="px-4 py-2.5"><ScheduleDialog title={`Edit ${item.name}`} trigger={item.name} triggerClassName="text-left font-medium hover:underline" submitLabel="Save"
                action={updateSchedule} remove={deleteSchedule} hidden={{ assumptionId: item.id }} categories={categories}
                defaults={{ name: item.name, amount: formatInputAmount(item.amount < 0n ? -item.amount : item.amount, item.currency_code), direction: item.amount < 0n ? "out" : "in",
                  cadence: item.cadence, startsOn: item.next ?? item.starts_on, category: item.category?.name ?? "", currencyCode: item.currency_code }} />
                <span className="ml-2 text-xs text-muted-foreground">{item.account_id ? names[item.account_id] ?? "Unknown account" : "No account"}</span></td>
              <td className="px-3 py-2.5 text-muted-foreground">{item.category?.name ?? "—"}</td>
              <td className="px-3 py-2.5 capitalize">{item.cadence}</td>
              <td className="whitespace-nowrap px-3 py-2.5 font-mono">{item.next ?? "Ended"}</td>
              <td className={`whitespace-nowrap px-4 py-2.5 text-right font-mono tabular-nums ${item.amount > 0n ? "text-success" : ""}`}>{money(item.amount, item.currency_code)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">No confirmed schedules yet. Confirm a detected pattern below or add one with Add recurring.</p>}
        <p className="text-xs text-muted-foreground">Click a name to change its amount, date or category, or to remove it. Pause or end a schedule in <Link href="/plan" className="underline">Plan</Link>. Monthly totals are per currency (52 weeks a year).</p>
      </section>

      <Suspense fallback={<p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">Looking for recurring patterns in your history…</p>}>
        <DetectedPatterns supabase={supabase} workspace={workspace} names={names} today={today} categories={categories} />
      </Suspense>
      <Suspense fallback={null}>
        <OccurrenceReview supabase={supabase} workspace={workspace} accountNames={names} />
      </Suspense>
    </main>
  );
}
