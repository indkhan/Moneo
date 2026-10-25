import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { recurringCadences } from "@/lib/finance/cadences";
import { calendarDate } from "@/lib/finance/calendar";
import { expandSchedule } from "@/lib/finance/model";
import { formatMoney, monthlyEquivalent } from "./series";
import { DetectedPatterns } from "./detected";
import { OccurrenceReview } from "./occurrences";

type Schedule = { id: string; name: string; account_id: string | null; amount_minor: string; currency_code: string; cadence: string; starts_on: string; ends_on: string | null; schedule_anchor_on: string | null; source: string };
const UPCOMING_DAYS = 30;

export default async function RecurringPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const money = (amount: string | bigint, currency: string) => formatMoney(amount, currency, workspace.locale);
  const today = calendarDate(new Date(), workspace.timezone);

  const [{ data: accounts, error: accountsError }, { data: scheduleData, error: schedulesError }] = await Promise.all([
    supabase.from("accounts").select("id, name").eq("workspace_id", workspace.id).order("name"),
    supabase.from("financial_assumptions").select("id, name, account_id, amount_minor::text, currency_code, cadence, starts_on, ends_on, schedule_anchor_on, source")
      .eq("workspace_id", workspace.id).eq("confirmed", true).eq("enabled", true).is("removed_at", null).in("cadence", recurringCadences).order("name").limit(500),
  ]);
  const names: Record<string, string> = Object.fromEntries((accounts ?? []).map(account => [account.id, account.name]));

  // Same expansion as the forecast, so "next" here matches Plan. Account-less schedules still get a date.
  const schedules = ((scheduleData ?? []) as Schedule[]).map(item => {
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
    <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-8 text-foreground sm:px-8 lg:py-10">
      <header className="space-y-4">
        <div>
          <h1 className="page-title">Recurring payments</h1>
          <p className="mt-1 text-sm text-muted-foreground">Confirmed bills, subscriptions and income. Suggestions below only reach your forecast once you confirm them.</p>
        </div>
      </header>
      {accountsError && <p role="alert">Could not load accounts: {accountsError.message}</p>}

      <section aria-label="Bills and subscriptions" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-base font-semibold">Bills and subscriptions</h2>
          {totals.size > 0 && <dl className="flex flex-wrap gap-x-6 gap-y-1 text-right text-sm">{[...totals].map(([currency, total]) => <div key={currency} className="grid">
            <dt className="text-xs text-muted-foreground">Per month ({currency})</dt>
            <dd className="font-mono font-semibold tabular-nums">{money(total.out, currency)}{total.in > 0n && <span className="ml-2 text-emerald-700 dark:text-emerald-400">+{money(total.in, currency)} in</span>}</dd>
            <dd className="text-xs text-muted-foreground">Next {UPCOMING_DAYS} days: {money(total.upcoming, currency)}</dd>
          </div>)}</dl>}
        </div>
        {schedulesError ? <p role="alert">Could not load confirmed schedules: {schedulesError.message}</p> : schedules.length ? <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground"><tr>
              <th className="px-4 py-2.5 font-medium">Name</th><th className="px-3 py-2.5 font-medium">Cadence</th><th className="px-3 py-2.5 font-medium">Next</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
            </tr></thead>
            <tbody className="divide-y divide-border">{schedules.map(item => <tr key={item.id} className={item.next ? "" : "text-muted-foreground"}>
              <td className="px-4 py-2.5"><Link href="/plan" className="font-medium hover:underline">{item.name}</Link><span className="ml-2 text-xs text-muted-foreground">{item.account_id ? names[item.account_id] ?? "Unknown account" : "No account"}</span></td>
              <td className="px-3 py-2.5 capitalize">{item.cadence}</td>
              <td className="whitespace-nowrap px-3 py-2.5 font-mono">{item.next ?? "Ended"}</td>
              <td className={`whitespace-nowrap px-4 py-2.5 text-right font-mono tabular-nums ${item.amount > 0n ? "text-emerald-700 dark:text-emerald-400" : ""}`}>{money(item.amount, item.currency_code)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">No confirmed schedules yet. Confirm a detected pattern below or add one in <Link href="/plan" className="underline">Plan</Link>.</p>}
        <p className="text-xs text-muted-foreground">Edit, pause or end a schedule in <Link href="/plan" className="underline">Plan</Link>. Monthly totals are per currency (52 weeks a year).</p>
      </section>

      <Suspense fallback={<p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">Looking for recurring patterns in your history…</p>}>
        <DetectedPatterns supabase={supabase} workspace={workspace} names={names} />
      </Suspense>
      <Suspense fallback={null}>
        <OccurrenceReview supabase={supabase} workspace={workspace} accountNames={names} />
      </Suspense>
    </main>
  );
}
