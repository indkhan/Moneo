import Link from "next/link";
import type { ReactNode } from "react";
import { BUILTIN_WIDGETS, dashboardItems, dashboardLayoutSchema } from "@/lib/dashboard";
import { saveDashboard } from "./dashboard-actions";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { hasSupabase } from "@/lib/env";
import { convertFx } from "@/lib/finance/fx";
import { createAccount, setManualBalance } from "./actions";
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { evaluatePlan } from "@/lib/finance/model";
import { cashflow } from "@/lib/finance/tools";
import { ArrowRight, Landmark, Plus, Wallet } from "lucide-react";

const money = formatMoney;

export default async function Home() {
  if (!hasSupabase()) return <main className="mx-auto max-w-3xl p-8">Configure Supabase in .env to start Moneo.</main>;
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/login");
  }
  const { supabase, workspace } = context;
  const mutedInsights = context.settings?.muted_insight_types ?? [];
  const today = calendarDate(new Date(), workspace.timezone);
  const [balanceEvidence, ledgerCount, projection, spending] = await Promise.all([
    loadBalanceEvidence(supabase, workspace.id),
    supabase.from("transactions").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id),
    evaluatePlan(),
    cashflow({ from: `${today.slice(0, 7)}-01`, to: today, currencyCode: workspace.display_currency }),
  ]);
  if (ledgerCount.error) throw ledgerCount.error;
  const transactionCount = ledgerCount.count;
  const accounts = resolveBalances(balanceEvidence.accounts, balanceEvidence.snapshots, balanceEvidence.ledger, balanceEvidence.asOf, workspace.timezone);
  const latest = new Map(accounts.map(account => [account.id, account.balance]));
  const { data: fxRates } = await supabase.from("fx_rates")
    .select("from_currency, to_currency, rate_text, rate_date, source")
    .eq("workspace_id", workspace.id)
    .order("rate_date", { ascending: false }).order("created_at", { ascending: false });
  const displayCurrency: string = workspace.display_currency;
  const missingInputs: string[] = [];
  let netWorthMinor = 0n;
  let convertedCount = 0;
  for (const account of accounts ?? []) {
    const balance = latest.get(account.id);
    if (!balance || balance.amount_minor === null) {
      missingInputs.push(`balance:${account.name}`);
      continue;
    }
    const balanceDate = calendarDate(balance.as_of!, workspace.timezone);
    const rate = balance.currency_code === displayCurrency ? undefined
      : (fxRates ?? []).find((row) =>
        row.from_currency === balance.currency_code &&
        row.to_currency === displayCurrency &&
        String(row.rate_date).slice(0, 10) <= balanceDate);
    try {
      const result = convertFx({
        amountMinor: BigInt(balance.amount_minor),
        from: balance.currency_code,
        to: displayCurrency,
        rate: balance.currency_code === displayCurrency ? undefined : rate?.rate_text,
        source: rate?.source ?? (balance.provenance || "balance"),
        date: rate ? String(rate.rate_date).slice(0, 10) : balanceDate,
      });
      if (result.status === "available") {
        netWorthMinor += result.converted.amountMinor;
        convertedCount += 1;
      } else {
        for (const missing of result.missingInputs) missingInputs.push(`${missing} for ${account.name}`);
      }
    } catch {
      missingInputs.push(`rate:${balance.currency_code}->${displayCurrency} for ${account.name}`);
    }
  }
  const { data: pins } = await supabase.from("dashboard_items")
    .select("artifact_id, position").eq("workspace_id", workspace.id).order("position");
  const { data: pinnedArtifacts } = pins?.length ? await supabase.from("artifacts")
    .select("id, name, kind").eq("workspace_id", workspace.id).in("id", pins.map(pin => pin.artifact_id))
    : { data: [] as { id: string; name: string; kind: string }[] };
  const pinnedById = new Map(pinnedArtifacts?.map(artifact => [artifact.id, artifact]));

  const [layout, goals, allocations] = await Promise.all([
    supabase.from("dashboard_layouts").select("items, version").eq("workspace_id", workspace.id).maybeSingle(),
    supabase.from("goals").select("id, name, target_minor::text, currency_code, target_date").eq("workspace_id", workspace.id).eq("status", "active").order("priority").limit(10),
    supabase.from("goal_allocations").select("goal_id, account_id, amount_minor::text").eq("workspace_id", workspace.id),
  ]);
  for (const error of [layout.error, goals.error, allocations.error]) if (error) throw error;
  const parsedLayout = layout.data ? dashboardLayoutSchema.safeParse(layout.data.items) : null;
  if (parsedLayout && !parsedLayout.success) throw new Error("Dashboard preferences are invalid; reset them in Home");
  const ordered = dashboardItems(parsedLayout?.success ? parsedLayout.data : null, (pins ?? []).map(pin => pin.artifact_id));
  const choices = [...new Set([...ordered, ...Object.keys(BUILTIN_WIDGETS), ...(pins ?? []).map(pin => `tool:${pin.artifact_id}`)])];
  const widgets: Record<string, ReactNode> = {
    overview: <section aria-label="Overview" className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(250px,1fr)]">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Net worth</p><p className="mt-1 text-xs text-muted-foreground">Verified current balances in {displayCurrency}</p></div><Link href="/plan/currency" className="text-xs font-medium text-brand hover:underline">Manage currency</Link></div>
          {!accounts?.length ? <p className="mt-7 text-sm text-muted-foreground">Add an account to see your net worth.</p> : convertedCount > 0 ? <><p className="mt-5 font-mono text-4xl font-semibold tracking-tight">{money(netWorthMinor, displayCurrency)}{missingInputs.length > 0 && <span className="ml-2 align-middle text-xs font-normal text-amber-700">Partial</span>}</p><p className="mt-2 text-xs text-muted-foreground">{missingInputs.length > 0 ? "Excludes missing, stale, ambiguous balances and missing exchange rates." : "Debts entered as negative balances are included."}</p>{missingInputs.length > 0 && <details className="mt-4 text-xs text-muted-foreground"><summary className="cursor-pointer text-brand">See missing inputs</summary><p className="mt-2">{missingInputs.join(", ")}</p></details>}</> : <><p className="mt-6 text-sm text-muted-foreground">Net worth unavailable in {displayCurrency}.</p><p className="mt-2 text-xs text-muted-foreground">{missingInputs.join(", ")}</p></>}
        </div>
        <Link href="/money/transactions" className="group flex flex-col justify-between rounded-xl border border-border bg-card p-6 shadow-sm hover:border-blue-300"><div className="flex items-center justify-between"><span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Transactions</span><ArrowRight size={16} className="text-brand transition-transform group-hover:translate-x-1" /></div><div><p className="font-mono text-4xl font-semibold">{transactionCount ?? 0}</p><p className="mt-2 text-xs text-muted-foreground">Accepted ledger entries</p></div></Link>
      </section>,
    planning: <section aria-label="Spending and planning" className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm"><h2 className="text-base font-semibold">Available to spend</h2>
          {projection.available.status === "available" ? <><p className="mt-3 font-mono text-2xl font-semibold">{money(projection.available.amountMinor, displayCurrency)}</p><p className="mt-2 text-xs text-muted-foreground">Estimated conservative minimum through 30 days; limiting date {projection.available.limitingDate}. Includes reservations and confirmed assumptions.</p></> : <p className="mt-3 text-sm text-muted-foreground">Unavailable: {projection.available.missingInputs.join(", ")}</p>}
          <Link href="/plan" className="mt-3 inline-block text-xs font-medium text-brand">Review forecast and goals</Link></div>
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm"><h2 className="text-base font-semibold">Spending this month</h2>
          {"unavailable" in spending ? <p className="mt-3 text-sm text-muted-foreground">{spending.unavailable}</p> : <><p className="mt-3 font-mono text-2xl font-semibold">{money(spending.spendingMinor, displayCurrency)}</p><p className="mt-2 text-xs text-muted-foreground">{spending.from} to {spending.to}; posted spending net of refunds. Pending and transfers excluded.{spending.evidence.partial ? ` Partial: ${spending.evidence.excludedReviewRows} transactions need classification review.` : ""}</p></>}
          <Link href="/plan/spending" className="mt-3 inline-block text-xs font-medium text-brand">Review monthly spending plans</Link></div>
      </section>,
    accounts: <section className="space-y-4"><div className="flex items-center justify-between"><div className="flex items-center gap-3"><span className="rounded-lg bg-blue-50 p-2 text-brand"><Landmark size={18} /></span><div><h2 className="text-base font-semibold">Accounts</h2><p className="text-xs text-muted-foreground">Balances you can verify and update</p></div></div><span className="font-mono text-xs text-muted-foreground">{accounts?.length ?? 0} total</span></div>
          {!accounts?.length && <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No accounts yet. <Link className="text-brand underline" href="/import">Import a statement</Link> or add one below.</div>}
          <div className="grid gap-3 md:grid-cols-2">{accounts?.map((account) => { const balance = latest.get(account.id)!; return <article key={account.id} className="rounded-xl border border-border bg-card p-5 shadow-sm"><div className="flex items-start gap-3"><span className="rounded-lg bg-muted p-2 text-muted-foreground"><Wallet size={17} /></span><div className="min-w-0"><h3 className="truncate text-sm font-semibold">{account.name}</h3><p className="text-[11px] capitalize text-muted-foreground">{account.type}</p></div></div><p className="mt-5 font-mono text-xl font-semibold">{balance.snapshot_amount_minor !== null ? money(balance.snapshot_amount_minor, balance.snapshot_currency_code!) : "Balance unknown"}</p><p className="mt-1 text-[11px] text-muted-foreground">{balance.as_of ? `${balance.provenance} - as of ${calendarDate(balance.as_of, workspace.timezone)} - ${balance.status}` : "Add a dated balance"}</p>{balance.warnings.length > 0 && <p className="mt-2 text-xs text-amber-700">{balance.warnings.join("; ")}</p>}{balance.status === "stale" && balance.estimated_amount_minor !== null && <p className="mt-2 text-xs text-muted-foreground">Recorded later activity gives an unverified estimate of {money(balance.estimated_amount_minor, balance.currency_code)}; update the dated balance to verify current funds.</p>}<form action={setManualBalance} className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-xs"><input type="hidden" name="accountId" value={account.id} /><input name="amount" required placeholder="Booked balance" aria-label={`${account.name} balance`} className="w-24 rounded-md border border-border bg-card p-2" /><input name="asOf" required type="date" defaultValue={today} aria-label="Balance as of" className="min-w-0 rounded-md border border-border bg-card p-2" /><button className="font-medium text-brand hover:underline">Save</button></form></article>; })}</div>
          <form action={createAccount} className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4"><input name="name" required maxLength={120} placeholder="Account name" aria-label="Account name" className="min-w-36 flex-1 rounded-md border border-border p-2 text-xs" /><select name="type" aria-label="Account type" className="rounded-md border border-border p-2 text-xs"><option value="checking">Checking</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="credit">Credit</option><option value="investment">Investment</option><option value="wallet">Wallet</option><option value="other">Other</option></select><input name="currency" defaultValue={workspace.display_currency} maxLength={3} aria-label="Currency code" className="w-16 rounded-md border border-border p-2 text-xs" /><button className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-xs font-medium text-white"><Plus size={14} /> Add account</button></form>
        </section>,
    upcoming: <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">Upcoming payments</h2><p className="mt-1 text-xs text-muted-foreground">Confirmed forecast obligations over the next 30 days, in {displayCurrency}. Review the Financial Model for sources and assumptions.</p><ul className="mt-3 space-y-2">{(projection.input?.events ?? []).filter(event => event.expectedMinor < 0n).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10).map((event, index) => <li key={`${event.accountId}:${event.date}:${index}`} className="flex justify-between gap-3 text-sm"><span>{event.date} ? {accounts.find(account => account.id === event.accountId)?.name ?? "Account"}</span><span>{money(event.expectedMinor, displayCurrency)}</span></li>)}</ul>{!(projection.input?.events ?? []).some(event => event.expectedMinor < 0n) && <p className="mt-3 text-sm text-muted-foreground">No confirmed payments in this forecast. Missing obligations may still exist.</p>}<Link href="/money/recurring" className="mt-3 inline-block text-sm underline">Review recurring payments</Link></section>,
    goals: <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">Goals</h2><p className="mt-1 text-xs text-muted-foreground">Virtual reservations do not move money. Original currencies are preserved.</p><ul className="mt-3 space-y-3">{(goals.data ?? []).map(goal => { const reservations = (allocations.data ?? []).filter(row => row.goal_id === goal.id); const comparable = reservations.every(row => accounts.find(account => account.id === row.account_id)?.currency_code === goal.currency_code); const reserved = reservations.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n); return <li key={goal.id} className="text-sm"><Link href="/plan" className="font-medium underline">{goal.name}</Link><p className="text-muted-foreground">{comparable ? money(reserved, goal.currency_code) : "Reservation conversion required"} reserved of {money(goal.target_minor, goal.currency_code)}{goal.target_date ? ` ? target ${goal.target_date}` : ""}</p></li>; })}</ul>{!goals.data?.length && <p className="mt-3 text-sm text-muted-foreground">No goals yet. <Link href="/plan" className="underline">Create a goal</Link>.</p>}</section>,
    insights: <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">Important insights</h2><ul className="mt-3 space-y-2 text-sm">{!mutedInsights.includes("data_quality") && missingInputs.length > 0 && <li><Link href="/plan/currency" className="underline">Resolve {missingInputs.length} missing balance or currency inputs</Link> before relying on net worth.</li>}{!mutedInsights.includes("cash_shortfall") && projection.available.status === "available" && projection.available.amountMinor < 0n && <li><Link href="/plan" className="underline">Forecast cash shortfall</Link> at {projection.available.limitingDate}: {money(projection.available.amountMinor, displayCurrency)}.</li>}{!mutedInsights.includes("data_quality") && !("unavailable" in spending) && spending.evidence.partial && <li><Link href="/import" className="underline">Review {spending.evidence.excludedReviewRows} uncertain transactions</Link> to complete spending totals.</li>}</ul><p className="mt-3 text-xs text-muted-foreground">Calculated from current evidence; no unsupported anomaly or probability claims.</p></section>,
  };
  for (const artifact of pinnedArtifacts ?? []) widgets[`tool:${artifact.id}`] = <section className="rounded-xl border border-border bg-card p-5"><p className="text-xs text-muted-foreground">Saved tool ? {artifact.kind.replaceAll("_", " ")}</p><Link href={`/ai/library/${artifact.id}`} className="mt-2 inline-flex items-center gap-2 font-semibold underline">{artifact.name}<ArrowRight size={15} /></Link><p className="mt-2 text-xs text-muted-foreground">Open for current scoped data and remembered settings.</p></section>;

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 text-foreground sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand">Workspace overview</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">Home</h1><p className="mt-1 text-sm text-muted-foreground">Your accounts, ledger, and saved tools in one place. Enter booked balances before pending holds; available bank balances already include holds and are not supported here.</p></div>
        <Link href="/import" className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white hover:bg-blue-800"><Plus size={15} /> Import statement</Link>
      </header>
      <details className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer font-medium">Customize Home</summary><form action={saveDashboard} className="mt-4 space-y-3"><input type="hidden" name="version" value={layout.data?.version ?? 0} />{choices.map((key, index) => <div key={key} className="flex flex-wrap items-center gap-3"><label className="flex flex-1 items-center gap-2 text-sm"><input type="checkbox" name="enabled" value={key} defaultChecked={ordered.includes(key)} disabled={key.startsWith("tool:")} />{key.startsWith("tool:") && <input type="hidden" name="enabled" value={key} />}{Object.hasOwn(BUILTIN_WIDGETS, key) ? BUILTIN_WIDGETS[key as keyof typeof BUILTIN_WIDGETS] : pinnedById.get(key.slice(5))?.name}</label><label className="flex items-center gap-2 text-xs">Position<input type="number" name={`position:${key}`} min="1" max="50" defaultValue={ordered.includes(key) ? ordered.indexOf(key) + 1 : index + 1} className="w-16 rounded border border-border bg-background p-2" /></label></div>)}<button className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Save dashboard</button><p className="text-xs text-muted-foreground">Pin or unpin tools in the <Link href="/ai/library" className="underline">Library</Link>. Lower positions appear first.</p></form></details>
      {ordered.map(key => <div key={key}>{widgets[key]}</div>)}
    </main>
  );
}
