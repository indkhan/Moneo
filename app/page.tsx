import Link from "next/link";
import { HomeLiquidity } from "./account-liquidity-summary";
import { DatedOverview } from "./dated-overview";
import { ManualBalanceForm } from "./manual-balance-form";
import { ImportantInsights, loadInsightEvidence } from "./insights/panel";
import { Kpi, KpiFallback, MonthSpendingKpi, RecentTransactions, SectionFallback, SpendingPanel, card } from "./home-sections";
import { Suspense, type ReactNode } from "react";
import { dashboardItems, dashboardLayoutSchema } from "@/lib/dashboard";
import { loadHomeSpending } from "@/lib/dashboard-spending";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { getSupabaseConfig } from "@/lib/env";
import { convertFx } from "@/lib/finance/fx";
import { createAccount } from "./actions";
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";
import { describeMissingInputs, formatMoney } from "@/lib/finance/format";
import { evaluatePlanForWorkspace } from "@/lib/finance/model";
import { SourceCoverageDetails } from "./source-coverage";
import { AgentBriefing } from "./agent-briefing";
import { AskAbout } from "@/components/ask-about";
import { loadSourceCoverageMetadata } from "@/lib/finance/source-coverage";
import { loadWealthItems, wealthEvidence } from "@/lib/finance/wealth";
import { ArrowRight, Plus } from "lucide-react";

const WIDE = new Set(["overview", "spending", "accounts"]);

export default async function Home({ searchParams }: { searchParams?: Promise<{ account?: string }> } = {}) {
  const params = await searchParams;
  const accountId = typeof params?.account === "string" ? params.account : undefined;
  const supabaseConfig = getSupabaseConfig();
  if (supabaseConfig.status !== "configured") return <main className="mx-auto max-w-3xl p-8">{supabaseConfig.detail}</main>;
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/login");
  }
  const { supabase, workspace } = context;
  const displayCurrency: string = workspace.display_currency;
  const locale = workspace.locale;
  const money = (amount: bigint | string | number, currency: string) => formatMoney(amount, currency, locale);
  const today = calendarDate(new Date(), workspace.timezone);
  const balanceEvidencePromise = loadBalanceEvidence(supabase, workspace.id);
  const wealthPromise = loadWealthItems(supabase, workspace.id);
  const sourceMetadataPromise = loadSourceCoverageMetadata(supabase, workspace.id, true);
  // Start the streamed sections' reads now (memoized); their Suspense boundaries pick up the same promises.
  loadInsightEvidence(supabase, workspace.id, displayCurrency, today).catch(() => undefined);
  loadHomeSpending(supabase, workspace.id, displayCurrency, today).catch(() => undefined);
  const [balanceEvidence, projection, wealthItems, rates, pinnedItems, layout, goals, allocations, sourceMetadata] = await Promise.all([
    balanceEvidencePromise,
    evaluatePlanForWorkspace(supabase, workspace, 30, undefined, { balanceEvidence: balanceEvidencePromise, wealth: wealthPromise, sourceMetadata: sourceMetadataPromise }),
    wealthPromise,
    supabase.from("fx_rates").select("from_currency, to_currency, rate_text, rate_date, source")
      .eq("workspace_id", workspace.id).eq("to_currency", displayCurrency).order("rate_date", { ascending: false }).order("created_at", { ascending: false }),
    supabase.from("dashboard_items").select("artifact_id, position, artifacts(id, name, kind, updated_at)").eq("workspace_id", workspace.id).eq("artifacts.workspace_id", workspace.id).order("position"),
    supabase.from("dashboard_layouts").select("items, version").eq("workspace_id", workspace.id).maybeSingle(),
    supabase.from("goals").select("id, name, target_minor::text, currency_code, target_date").eq("workspace_id", workspace.id).eq("status", "active").order("priority").limit(10),
    supabase.from("goal_allocations").select("goal_id, account_id, amount_minor::text").eq("workspace_id", workspace.id),
    sourceMetadataPromise,
  ]);
  for (const error of [rates.error, pinnedItems.error, layout.error, goals.error, allocations.error]) if (error) throw error;
  const accounts = resolveBalances(balanceEvidence.accounts, balanceEvidence.snapshots, balanceEvidence.ledger, balanceEvidence.asOf, workspace.timezone, sourceMetadata).filter(account => !account.archived_at);
  const accountNames = new Map(accounts.map(account => [account.id, account.name]));
  const fxRates = rates.data ?? [];

  // Net worth: dated balances and valuations converted with the latest rate on or before each observation.
  const missingInputs: string[] = [];
  let netWorthMinor = 0n;
  let convertedCount = 0;
  const addConverted = (amountMinor: bigint, from: string, asOf: string, source: string, name: string) => {
    const rate = from === displayCurrency ? undefined : fxRates.find(row => row.from_currency === from && String(row.rate_date).slice(0, 10) <= asOf);
    try {
      const result = convertFx({ amountMinor, from, to: displayCurrency, rate: rate?.rate_text, source: rate?.source ?? source, date: rate ? String(rate.rate_date).slice(0, 10) : asOf });
      if (result.status === "available") { netWorthMinor += result.converted.amountMinor; convertedCount += 1; }
      else missingInputs.push(...result.missingInputs.map(input => `${input} for ${name}`));
    } catch {
      missingInputs.push(`rate:${from}->${displayCurrency} for ${name}`);
    }
  };
  for (const account of accounts) {
    const { balance } = account;
    if (balance.amount_minor === null) { missingInputs.push(`balance:${account.name}`); continue; }
    addConverted(BigInt(balance.amount_minor), balance.currency_code, calendarDate(balance.as_of!, workspace.timezone), balance.provenance || "balance", account.name);
  }
  const valuations = wealthEvidence(wealthItems, today);
  missingInputs.push(...valuations.missingInputs);
  for (const valuation of valuations.included) addConverted(valuation.amountMinor, valuation.currencyCode, valuation.asOf, valuation.provenance, valuation.name);

  const upcoming = (projection.input?.events ?? []).filter(event => event.expectedMinor < 0n && event.source !== "estimated").sort((a, b) => a.date.localeCompare(b.date));
  const upcomingMinor = upcoming.reduce((sum, event) => sum + event.expectedMinor, 0n);
  const available = projection.available;
  const pins = pinnedItems.data as { artifact_id: string; artifacts: { id: string; name: string; kind: string; updated_at: string } | null }[] | null;
  const pinnedArtifacts = new Map((pins ?? []).flatMap(pin => pin.artifacts ? [[`tool:${pin.artifacts.id}` as string, pin.artifacts] as const] : []));
  const parsedLayout = layout.data ? dashboardLayoutSchema.safeParse(layout.data.items) : null;
  if (parsedLayout && !parsedLayout.success) throw new Error("Dashboard preferences are invalid; review them in Settings");
  const ordered = dashboardItems(parsedLayout?.success ? parsedLayout.data : null, (pins ?? []).map(pin => pin.artifact_id));
  const sectionProps = { db: supabase, workspaceId: workspace.id, currency: displayCurrency, today, locale };

  const widgets: Record<string, ReactNode> = {
    overview: <section aria-label="Overview" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Net worth" href="/plan/currency" action={displayCurrency}>
          {!accounts.length && !wealthItems.length ? <p className="mt-2 text-sm text-muted-foreground">Add an account to see your net worth.</p>
            : convertedCount > 0 ? <p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{money(netWorthMinor, displayCurrency)}{missingInputs.length > 0 && <span className="ml-2 align-middle text-xs font-normal text-amber-700">Partial</span>}</p>
            : <p className="mt-2 text-sm text-muted-foreground">Net worth unavailable in {displayCurrency}.</p>}
          {missingInputs.length > 0 ? <details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer text-brand">{convertedCount > 0 ? "Some balances or rates are missing" : "See what is missing"}</summary><ul className="mt-2 list-disc space-y-1 pl-4">{describeMissingInputs(missingInputs).map(item => <li key={item}>{item}</li>)}</ul><Link href="/money/wealth" className="mt-2 inline-block underline">Review dated valuations</Link></details>
            : convertedCount > 0 && <p className="mt-1 text-xs text-muted-foreground">Includes debts and valuations.</p>}
        </Kpi>
        <Kpi label="Cash available" href="/plan" action="Forecast">
          {available?.status === "available" ? <><p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{money(available.amountMinor, displayCurrency)}</p><p className="mt-1 text-xs text-muted-foreground">Lowest point in 30 days after protections, on {available.limitingDate}</p></>
            : <p className="mt-2 text-sm text-muted-foreground">Needs current balances and confirmed payments to forecast.</p>}
        </Kpi>
        <Suspense fallback={<KpiFallback label="Spent this month" />}><MonthSpendingKpi {...sectionProps} /></Suspense>
        <Kpi label="Upcoming payments" href="/money/recurring" action="Recurring">
          {upcoming.length ? <><p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{money(-upcomingMinor, displayCurrency)}</p><p className="mt-1 truncate text-xs text-muted-foreground">{upcoming.length} confirmed in 30 days · next {upcoming[0].name ?? "payment"} on {upcoming[0].date}</p></>
            : <p className="mt-2 text-sm text-muted-foreground">No confirmed payments in the next 30 days.</p>}
        </Kpi>
      </div>
      <DatedOverview accounts={accounts} wealth={wealthItems} today={today} timeZone={workspace.timezone} locale={locale} />
    </section>,
    spending: <Suspense fallback={<SectionFallback title="Spending" />}><SpendingPanel {...sectionProps} /></Suspense>,
    recent: <Suspense fallback={<SectionFallback title="Recent transactions" />}><RecentTransactions db={supabase} workspaceId={workspace.id} locale={locale} names={accountNames} /></Suspense>,
    planning: projection.liquidity && <section aria-label="Available funds"><HomeLiquidity liquidity={projection.liquidity} accountId={accountId} names={accountNames} locale={locale} coverage={<SourceCoverageDetails coverage={projection.sourceCoverage} />} /></section>,
    accounts: <section aria-labelledby="home-accounts" className={card}>
      <div className="flex items-baseline justify-between gap-2"><h2 id="home-accounts" className="text-base font-semibold">Accounts</h2><span className="text-sm text-muted-foreground">{accounts.length} total</span></div>
      {!accounts.length && <p className="mt-3 text-sm text-muted-foreground">No accounts yet. <Link className="text-brand underline" href="/import">Import a statement</Link> or add one below.</p>}
      <ul className="mt-2 divide-y divide-border">{accounts.map(account => { const { balance } = account; return <li key={account.id}><article className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
        <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium">{account.name}</h3><p className="truncate text-xs text-muted-foreground"><span className="capitalize">{account.type}</span> · {balance.as_of ? `As of ${calendarDate(balance.as_of, workspace.timezone)} · ${balance.status.replaceAll("_", " ")}` : "Add a dated balance"}</p></div>
        <p className="font-mono text-sm font-semibold">{balance.snapshot_amount_minor !== null ? money(balance.snapshot_amount_minor, balance.snapshot_currency_code!) : "Balance unknown"}</p>
        <AskAbout label="Ask" question={`How is my ${account.name} account doing? Summarise recent activity, upcoming payments and its balance trend.`} about={{ kind: "account", id: account.id, label: account.name }} />
        <details className="open:w-full"><summary className="cursor-pointer text-xs font-medium text-brand hover:underline">Update balance</summary><div className="mt-2 rounded-lg border border-border p-3"><ManualBalanceForm account={account} snapshots={balanceEvidence.snapshots} ledger={balanceEvidence.ledger} asOf={balanceEvidence.asOf} timeZone={workspace.timezone} locale={locale} /></div></details>
        {balance.warnings.length > 0 && <p className="w-full text-xs text-amber-700">{balance.warnings.join("; ")}</p>}
        {balance.status === "stale" && balance.estimated_amount_minor !== null && <p className="w-full text-xs text-muted-foreground">Recent activity suggests about {money(balance.estimated_amount_minor, balance.currency_code)}. Update the balance to confirm.</p>}
      </article></li>; })}</ul>
      <form action={createAccount} className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"><input name="name" required maxLength={120} placeholder="New account name" aria-label="Account name" className="min-h-9 min-w-36 flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm" /><select name="type" aria-label="Account type" className="min-h-9 rounded-lg border border-border bg-card px-2 py-1.5 text-sm"><option value="checking">Checking</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="credit">Credit</option><option value="investment">Investment</option><option value="wallet">Wallet</option><option value="other">Other</option></select><input name="currency" defaultValue={displayCurrency} maxLength={3} aria-label="Currency code" className="min-h-9 w-16 rounded-lg border border-border bg-card px-2 py-1.5 text-sm" /><button className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"><Plus size={14} /> Add account</button></form>
    </section>,
    upcoming: <section className={card}>
      <div className="flex items-baseline justify-between gap-2"><h2 className="text-base font-semibold">Upcoming payments</h2><Link href="/money/recurring" className="text-sm font-medium text-brand hover:underline">Recurring</Link></div>
      <p className="mt-1 text-xs text-muted-foreground">Confirmed payments over the next 30 days, in {displayCurrency}.</p>
      {upcoming.length ? <ul className="mt-2 divide-y divide-border">{upcoming.slice(0, 8).map((event, index) => <li key={`${event.accountId}:${event.date}:${index}`} className="flex items-center gap-3 py-2 text-sm"><span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{event.date}</span><span className="min-w-0 flex-1 truncate">{event.name ?? "Confirmed payment"} <span className="text-xs text-muted-foreground">· {accountNames.get(event.accountId) ?? "Account"}</span></span><span className="shrink-0 font-mono">{money(event.expectedMinor, displayCurrency)}</span></li>)}</ul>
        : <p className="mt-3 text-sm text-muted-foreground">No confirmed payments in this forecast.</p>}
    </section>,
    goals: <section className={card}>
      <div className="flex items-baseline justify-between gap-2"><h2 className="text-base font-semibold">Goals</h2><Link href="/plan" className="text-sm font-medium text-brand hover:underline">Plan</Link></div>
      <p className="mt-1 text-xs text-muted-foreground">Reserving money for a goal does not move it.</p>
      <ul className="mt-2 divide-y divide-border">{(goals.data ?? []).map(goal => { const reservations = (allocations.data ?? []).filter(row => row.goal_id === goal.id); const comparable = reservations.every(row => accounts.find(account => account.id === row.account_id)?.currency_code === goal.currency_code); const reserved = reservations.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n); return <li key={goal.id} className="py-2 text-sm"><Link href="/plan" className="font-medium hover:underline">{goal.name}</Link><p className="text-xs text-muted-foreground">{comparable ? money(reserved, goal.currency_code) : "Reservation conversion required"} reserved of {money(goal.target_minor, goal.currency_code)}{goal.target_date ? ` · target ${goal.target_date}` : ""}</p></li>; })}</ul>
      {!goals.data?.length && <p className="mt-3 text-sm text-muted-foreground">No goals yet. <Link href="/plan" className="underline">Create a goal</Link>.</p>}
    </section>,
    insights: <Suspense fallback={<SectionFallback title="Important insights" />}>
      <ImportantInsights db={supabase} workspaceId={workspace.id} currency={displayCurrency} today={today} settings={context.settings} projection={projection} missingInputs={missingInputs} names={accountNames} wealth={wealthItems} />
    </Suspense>,
  };

  // Consecutive pinned tools share one row of tiles.
  const rows: { key: string; wide: boolean; node: ReactNode }[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const key = ordered[index];
    if (!key.startsWith("tool:")) { rows.push({ key, wide: WIDE.has(key), node: widgets[key] }); continue; }
    const tools = [];
    while (index < ordered.length && ordered[index].startsWith("tool:")) { const tool = pinnedArtifacts.get(ordered[index]); if (tool) tools.push(tool); index++; }
    index--;
    if (tools.length) rows.push({ key, wide: true, node: <section aria-label="Pinned tools" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{tools.map(tool => <Link key={tool.id} href={`/ai/library/${tool.id}`} className="group flex min-w-0 flex-col justify-between gap-3 rounded-xl border border-border bg-card p-4 hover:border-brand">
      <span className="text-xs font-medium capitalize text-muted-foreground">{tool.kind.replaceAll("_", " ")}</span>
      <span className="flex items-center justify-between gap-2 font-semibold"><span className="truncate">{tool.name}</span><ArrowRight size={15} className="shrink-0 text-brand transition-transform group-hover:translate-x-1" /></span>
      <span className="text-xs text-muted-foreground">{tool.updated_at ? `Updated ${tool.updated_at.slice(0, 10)} · ` : ""}Opens with current data</span>
    </Link>)}</section> });
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6 text-foreground sm:px-8 lg:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">Home</h1><p className="text-sm text-muted-foreground">As of {today} · {displayCurrency}</p></div>
        <div className="flex items-center gap-2">
          <Link href="/settings" className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted">Customize</Link>
          <Link href="/import" className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"><Plus size={15} /> Import statement</Link>
        </div>
      </header>
      <Suspense fallback={null}><AgentBriefing db={supabase} workspaceId={workspace.id} /></Suspense>
      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map(row => <div key={row.key} className={row.wide ? "min-w-0 lg:col-span-2" : "min-w-0"}>{row.node}</div>)}
      </div>
    </main>
  );
}
