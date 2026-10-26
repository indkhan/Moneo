import Link from "next/link";
import { HomeLiquidity } from "./account-liquidity-summary";
import { ManualBalanceForm } from "./manual-balance-form";
import { ImportantInsights, loadInsightEvidence } from "./insights/panel";
import { CashFlowPanel, Figure, MonthCashFlow, RecentTransactions, SectionFallback, card } from "./home-sections";
import { Suspense, type ReactNode } from "react";
import { artifactIdFromKey, dashboardItems, dashboardLayoutSchema } from "@/lib/finance/dashboard";
import { ArtifactFrame } from "@/components/artifact-frame";
import { loadHomeSpending } from "@/lib/finance/dashboard-spending";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { getSupabaseConfig } from "@/lib/env";
import { convertFx, minorDigits } from "@/lib/finance/fx";
import { createAccount } from "./actions";
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";
import { describeMissingInputs, formatMoney } from "@/lib/finance/format";
import { evaluatePlanForWorkspace } from "@/lib/finance/model";
import { SourceCoverageDetails } from "./source-coverage";
import { AgentBriefing } from "./agent-briefing";
import { HomeBudgets } from "./home-budgets";
import { AskAbout } from "@/components/ask-about";
import { loadSourceCoverageMetadata } from "@/lib/finance/source-coverage";
import { loadWealthItems, wealthEvidence } from "@/lib/finance/wealth";
import { loadWealthEvents, monthEnds, netWorth, netWorthSeries, removedOn, valuationHistory } from "./money/wealth/net-worth";
import { Sparkline } from "./money/accounts/sparkline";
import { LayoutGrid, Plus, Sparkle } from "lucide-react";

// The design pairs a wide card with a narrow one; dense flow fills the gaps whatever order the layout picks.
const FULL = new Set(["overview"]);
const WIDE = new Set(["spending", "accounts", "insights", "recent"]);

export default async function Home({ searchParams }: { searchParams?: Promise<{ account?: string; month?: string; flow?: string }> } = {}) {
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
  const allWealthPromise = loadWealthItems(supabase, workspace.id, true);
  const wealthPromise = allWealthPromise.then(items => items.filter(item => !item.removed_at));
  const sourceMetadataPromise = loadSourceCoverageMetadata(supabase, workspace.id, true);
  // Start the streamed sections' reads now (memoized); their Suspense boundaries pick up the same promises.
  loadInsightEvidence(supabase, workspace.id, displayCurrency, today).catch(() => undefined);
  loadHomeSpending(supabase, workspace.id, displayCurrency, today).catch(() => undefined);
  const layoutPromise = Promise.resolve(supabase.from("dashboard_layouts").select("items, version").eq("workspace_id", workspace.id).maybeSingle());
  // Pinned artifact titles chain onto the layout read, so they finish inside the slower forecast; the frames load their data themselves.
  const pinnedPromise = layoutPromise.then(async ({ data }) => {
    const ids = (Array.isArray(data?.items) ? data.items : []).map(artifactIdFromKey).filter(id => id !== null);
    return ids.length ? supabase.from("artifacts").select("id, title").eq("workspace_id", workspace.id).in("id", ids).is("deleted_at", null) : { data: [], error: null };
  });
  const [balanceEvidence, projection, wealthItems, rates, layout, pinned, goals, allocations, sourceMetadata, allWealth, wealthEvents] = await Promise.all([
    balanceEvidencePromise,
    evaluatePlanForWorkspace(supabase, workspace, 30, undefined, { balanceEvidence: balanceEvidencePromise, wealth: wealthPromise, sourceMetadata: sourceMetadataPromise }),
    wealthPromise,
    supabase.from("fx_rates").select("from_currency, to_currency, rate_text, rate_date, source")
      .eq("workspace_id", workspace.id).eq("to_currency", displayCurrency).order("rate_date", { ascending: false }).order("created_at", { ascending: false }),
    layoutPromise,
    pinnedPromise,
    supabase.from("goals").select("id, name, target_minor::text, currency_code, target_date").eq("workspace_id", workspace.id).eq("status", "active").order("priority").limit(10),
    supabase.from("goal_allocations").select("goal_id, account_id, amount_minor::text").eq("workspace_id", workspace.id),
    sourceMetadataPromise,
    allWealthPromise,
    loadWealthEvents(supabase, workspace.id),
  ]);
  for (const error of [rates.error, layout.error, pinned.error, goals.error, allocations.error]) if (error) throw error;
  const accounts = resolveBalances(balanceEvidence.accounts, balanceEvidence.snapshots, balanceEvidence.ledger, balanceEvidence.asOf, workspace.timezone, sourceMetadata, { preferLatestRecorded: true }).filter(account => !account.archived_at);
  const accountNames = new Map(accounts.map(account => [account.id, account.name]));
  const fxRates = rates.data ?? [];

  // Net worth: dated balances and valuations converted with the latest rate on or before each observation.
  const missingInputs: string[] = [];
  let netWorthMinor = 0n;
  let convertedCount = 0;
  // Split by sign for the hero: positive accounts, positive valuations, and everything owed.
  const parts = { cash: 0n, assets: 0n, debts: 0n };
  const addConverted = (amountMinor: bigint, from: string, asOf: string, source: string, name: string, part: "cash" | "assets") => {
    const rate = from === displayCurrency ? undefined : fxRates.find(row => row.from_currency === from && String(row.rate_date).slice(0, 10) <= asOf);
    try {
      const result = convertFx({ amountMinor, from, to: displayCurrency, rate: rate?.rate_text, source: rate?.source ?? source, date: rate ? String(rate.rate_date).slice(0, 10) : asOf });
      if (result.status === "available") {
        const converted = result.converted.amountMinor;
        netWorthMinor += converted; convertedCount += 1;
        parts[converted < 0n ? "debts" : part] += converted;
      }
      else missingInputs.push(...result.missingInputs.map(input => `${input} for ${name}`));
    } catch {
      missingInputs.push(`rate:${from}->${displayCurrency} for ${name}`);
    }
  };
  for (const account of accounts) {
    const { balance } = account;
    if (balance.amount_minor === null) { missingInputs.push(`balance:${account.name}`); continue; }
    addConverted(BigInt(balance.amount_minor), balance.currency_code, calendarDate(balance.as_of!, workspace.timezone), balance.provenance || "balance", account.name, "cash");
  }
  const valuations = wealthEvidence(wealthItems, today);
  missingInputs.push(...valuations.missingInputs);
  for (const valuation of valuations.included) addConverted(valuation.amountMinor, valuation.currencyCode, valuation.asOf, valuation.provenance, valuation.name, "assets");

  // Month-end net worth for the chart and the "this month" change; display currency only for now (see BACKLOG.md).
  const trend = netWorthSeries({ dates: monthEnds(today, 12), timeZone: workspace.timezone, accountIds: new Set(accounts.map(account => account.id)),
    snapshots: balanceEvidence.snapshots, valuations: valuationHistory(wealthEvents, allWealth), removedOn: removedOn(allWealth, workspace.timezone) })
    .map(point => ({ date: point.date, value: netWorth(point).get(displayCurrency) ?? 0n }));
  const monthChange = trend.at(-1)!.value - trend.at(-2)!.value, monthBase = trend.at(-2)!.value;
  const dayMonth = (date: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const dateTile = (date: string) => { const at = new Date(`${date}T00:00:00Z`); return { month: new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(at), day: date.slice(8, 10) }; };
  const monthLabel = (date: string) => new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

  const upcoming = (projection.input?.events ?? []).filter(event => event.expectedMinor < 0n && event.source !== "estimated").sort((a, b) => a.date.localeCompare(b.date));
  const upcomingMinor = upcoming.reduce((sum, event) => sum + event.expectedMinor, 0n);
  const available = projection.available;
  const parsedLayout = layout.data ? dashboardLayoutSchema.safeParse(layout.data.items) : null;
  if (parsedLayout && !parsedLayout.success) throw new Error("Dashboard preferences are invalid; review them in Settings");
  const pinnedTitles = new Map((pinned.data ?? []).map(artifact => [artifact.id as string, artifact.title as string]));
  // A deleted artifact simply drops off Home; its key is cleaned up the next time the layout is saved.
  const ordered = dashboardItems(parsedLayout?.success ? parsedLayout.data : null).filter(key => { const id = artifactIdFromKey(key); return !id || pinnedTitles.has(id); });
  const sectionProps = { db: supabase, workspaceId: workspace.id, currency: displayCurrency, today, locale };
  const search = { account: accountId, month: typeof params?.month === "string" ? params.month : undefined, flow: typeof params?.flow === "string" ? params.flow : undefined };

  const widgets: Record<string, ReactNode> = {
    ...Object.fromEntries([...pinnedTitles].map(([id, title]) => [`artifact:${id}`, <section key={id} aria-label={title} className={`${card} flex flex-col gap-3`}>
      <div className="flex items-baseline justify-between gap-2"><h2 className="truncate text-sm font-medium">{title}</h2><Link href={`/ai/artifacts/${id}`} className="shrink-0 text-sm font-medium text-brand hover:underline">Open</Link></div>
      <ArtifactFrame src={`/ai/artifacts/${id}/frame?view=widget`} title={title} loading="lazy" fit className="w-full" />
    </section>])),
    overview: <section aria-label="Overview" className="grid gap-4 lg:grid-cols-3">
      <div className={`${card} flex flex-col gap-5 lg:col-span-2`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5"><h2 className="text-sm font-medium">Net worth</h2>
            {convertedCount > 0 && <span className="rounded-md border border-dashed border-input px-2 py-0.5 font-mono text-[11px] text-muted-foreground">traced Â· {accounts.length} accounts Â· {valuations.included.length} valuations</span>}</div>
          <Link href="/plan/currency" className="rounded-lg border border-input px-2.5 py-1 font-mono text-xs text-muted-foreground hover:text-foreground">{displayCurrency}</Link>
        </div>
        {!accounts.length && !wealthItems.length ? <p className="text-sm text-muted-foreground">Add an account to see your net worth.</p>
          : convertedCount > 0 ? <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1"><Figure value={money(netWorthMinor, displayCurrency)} digits={minorDigits(displayCurrency)} className="display-figure text-5xl sm:text-7xl" />
            {monthChange !== 0n && <span className="font-mono text-sm text-muted-foreground"><span className={monthChange > 0n ? "text-brand" : "text-warning"}>{monthChange > 0n ? "+" : ""}{money(monthChange, displayCurrency)}</span> this month{monthBase > 0n ? ` · ${monthChange > 0n ? "+" : ""}${(Number(monthChange * 1000n / monthBase) / 10).toFixed(1)}%` : ""}</span>}</div>
          : <p className="text-sm text-muted-foreground">Net worth unavailable in {displayCurrency}.</p>}
        {convertedCount === 0 && missingInputs.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer text-brand">See what is missing</summary><ul className="mt-2 list-disc space-y-1 pl-4">{describeMissingInputs(missingInputs).map(item => <li key={item}>{item}</li>)}</ul><Link href="/money/wealth" className="mt-2 inline-block underline">Review dated valuations</Link></details>}
        {convertedCount > 0 && <div><Sparkline points={trend} area width={640} height={120} className="h-[120px] w-full text-brand" label={`Net worth in ${displayCurrency} at each month end`} />
          <p className="mt-2 flex justify-between font-mono text-[11px] text-subtle"><span>{monthLabel(trend[0].date)}</span><span>{monthLabel(trend[6].date)}</span><span>{monthLabel(today)}</span></p></div>}
        {convertedCount > 0 && <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-[14px] bg-border sm:grid-cols-3">
          {([["Cash & accounts", parts.cash, "/money/accounts"], ["Assets", parts.assets, "/money/wealth"], ["Debts", parts.debts, "/money/wealth"]] as const).map(([label, amount, href]) =>
            <div key={label} className="bg-card"><Link href={href} className="flex flex-col gap-1 px-4 py-3.5 hover:bg-muted"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-mono">{money(amount, displayCurrency)}</dd></Link></div>)}
        </dl>}
      </div>
      <Suspense fallback={<SectionFallback title="This month" />}><MonthCashFlow {...sectionProps} search={search}>
        {available?.status === "available" && <Link href="/plan" className="mt-auto flex flex-col gap-1.5 rounded-[14px] border border-ai-border bg-ai-soft p-3.5 hover:border-ai">
          <p className="flex items-center gap-2 text-xs text-ai"><Sparkle className="size-3.5 fill-current" aria-hidden="true" />Cash-flow forecaster</p>
          <p className="text-[13px]">Lowest point after your buffer: <span className={`font-mono ${available.amountMinor < 0n ? "text-warning" : ""}`}>{money(available.amountMinor, displayCurrency)}</span> on {dayMonth(available.limitingDate)}.</p>
        </Link>}
      </MonthCashFlow></Suspense>
    </section>,
    spending: <Suspense fallback={<SectionFallback title="Cash flow · 6 months" />}><CashFlowPanel {...sectionProps} search={search} /></Suspense>,
    recent: <Suspense fallback={<SectionFallback title="Recent transactions" />}><RecentTransactions db={supabase} workspaceId={workspace.id} locale={locale} names={accountNames} /></Suspense>,
    planning: projection.liquidity && <section aria-label="Available funds"><HomeLiquidity liquidity={projection.liquidity} accountId={accountId} names={accountNames} locale={locale} coverage={<SourceCoverageDetails coverage={projection.sourceCoverage} />} /></section>,
    accounts: <section aria-labelledby="home-accounts" className={card}>
      <div className="flex items-baseline justify-between gap-2"><h2 id="home-accounts" className="text-sm font-medium">Accounts</h2><span className="text-sm text-muted-foreground">{accounts.length} total</span></div>
      {!accounts.length && <p className="mt-3 text-sm text-muted-foreground">No accounts yet. <Link className="text-brand underline" href="/import">Import a statement</Link> or add one below.</p>}
      <ul className="mt-2 divide-y divide-border">{accounts.map(account => { const { balance } = account; return <li key={account.id}><article className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
        <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium">{account.name}</h3><p className="truncate text-xs text-muted-foreground"><span className="capitalize">{account.type}</span> Â· {balance.as_of ? `As of ${calendarDate(balance.as_of, workspace.timezone)} Â· ${balance.status.replaceAll("_", " ")}` : "Add a dated balance"}</p></div>
        <p className="font-mono text-sm font-semibold">{balance.snapshot_amount_minor !== null ? money(balance.snapshot_amount_minor, balance.snapshot_currency_code!) : "Balance unknown"}</p>
        <AskAbout label="Ask" question={`How is my ${account.name} account doing? Summarise recent activity, upcoming payments and its balance trend.`} about={{ kind: "account", id: account.id, label: account.name }} />
        <details className="open:w-full"><summary className="cursor-pointer text-xs font-medium text-brand hover:underline">Update balance</summary><div className="mt-2 rounded-lg border border-border p-3"><ManualBalanceForm account={account} snapshots={balanceEvidence.snapshots} ledger={balanceEvidence.ledger} asOf={balanceEvidence.asOf} timeZone={workspace.timezone} locale={locale} /></div></details>
        {balance.warnings.length > 0 && <p className="w-full text-xs text-warning">{balance.warnings.join("; ")}</p>}
        {balance.status === "stale" && balance.estimated_amount_minor !== null && <p className="w-full text-xs text-muted-foreground">Recent activity suggests about {money(balance.estimated_amount_minor, balance.currency_code)}. Update the balance to confirm.</p>}
      </article></li>; })}</ul>
      <form action={createAccount} className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"><input name="name" required maxLength={120} placeholder="New account name" aria-label="Account name" className="min-h-9 min-w-36 flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm" /><select name="type" aria-label="Account type" className="min-h-9 rounded-lg border border-border bg-card px-2 py-1.5 text-sm"><option value="checking">Checking</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="credit">Credit</option><option value="investment">Investment</option><option value="wallet">Wallet</option><option value="other">Other</option></select><input name="currency" defaultValue={displayCurrency} maxLength={3} aria-label="Currency code" className="min-h-9 w-16 rounded-lg border border-border bg-card px-2 py-1.5 text-sm" /><button className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"><Plus size={14} /> Add account</button></form>
    </section>,
    upcoming: <section aria-labelledby="home-upcoming" className={card}>
      <div className="flex items-baseline justify-between gap-2"><h2 id="home-upcoming" className="text-sm font-medium"><Link href="/money/recurring" className="hover:underline">Coming up</Link></h2>
        {upcoming.length > 0 && <span className="font-mono text-[11px] text-subtle">{money(-upcomingMinor, displayCurrency)} · {projection.input?.horizonDays ?? 30} days</span>}</div>
      {upcoming.length ? <ul className="mt-3 divide-y divide-border">{upcoming.slice(0, 6).map((event, index) => <li key={`${event.accountId}:${event.date}:${index}`} className="flex items-center gap-3 py-3">
        <span className="flex w-10 shrink-0 flex-col items-center rounded-lg border border-border py-1 leading-none"><span className="font-mono text-[9px] uppercase text-subtle">{dateTile(event.date).month}</span><span className="mt-0.5 font-mono text-[15px] font-semibold">{dateTile(event.date).day}</span></span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{event.name ?? "Confirmed payment"}</span><span className="block truncate text-xs text-muted-foreground">{event.source === "debt" ? "Loan payment" : "Recurring"} · {accountNames.get(event.accountId) ?? "Account"}</span></span>
        <span className="shrink-0 font-mono text-sm">{money(event.expectedMinor, displayCurrency)}</span></li>)}</ul>
        : <p className="mt-3 text-sm text-muted-foreground">No confirmed payments in the next {projection.input?.horizonDays ?? 30} days.</p>}
    </section>,
    budgets: <Suspense fallback={<SectionFallback title="Budgets" />}><HomeBudgets {...sectionProps} /></Suspense>,
    goals: <section className={card}>
      <div className="flex items-baseline justify-between gap-2"><h2 className="text-sm font-medium">Goals</h2><Link href="/plan" className="text-sm font-medium text-brand hover:underline">Plan</Link></div>
      <p className="mt-1 text-xs text-muted-foreground">Reserving money for a goal does not move it.</p>
      <ul className="mt-2 divide-y divide-border">{(goals.data ?? []).map(goal => { const reservations = (allocations.data ?? []).filter(row => row.goal_id === goal.id); const comparable = reservations.every(row => accounts.find(account => account.id === row.account_id)?.currency_code === goal.currency_code); const reserved = reservations.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n); return <li key={goal.id} className="py-2 text-sm"><Link href="/plan" className="font-medium hover:underline">{goal.name}</Link><p className="text-xs text-muted-foreground">{comparable ? money(reserved, goal.currency_code) : "Reservation conversion required"} reserved of {money(goal.target_minor, goal.currency_code)}{goal.target_date ? ` Â· target ${goal.target_date}` : ""}</p></li>; })}</ul>
      {!goals.data?.length && <p className="mt-3 text-sm text-muted-foreground">No goals yet. <Link href="/plan" className="underline">Create a goal</Link>.</p>}
    </section>,
    insights: <Suspense fallback={<SectionFallback title="Important insights" />}>
      <ImportantInsights db={supabase} workspaceId={workspace.id} currency={displayCurrency} today={today} settings={context.settings} projection={projection} missingInputs={missingInputs} names={accountNames} wealth={wealthItems} />
    </Suspense>,
  };

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-4 px-4 py-6 text-foreground sm:px-8 lg:py-8">
      <header className="mb-2 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1"><p className="eyebrow">{new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${today}T00:00:00Z`))} Â· {displayCurrency}</p><h1 className="page-title">Overview</h1></div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/settings" className="inline-flex h-11 items-center gap-2 rounded-xl border border-input px-4 text-[13px] hover:bg-muted"><LayoutGrid className="size-4" strokeWidth={1.6} aria-hidden="true" />Edit layout</Link>
          <Link href="/import" className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-medium text-primary-foreground hover:opacity-90"><Plus size={15} /> Import statement</Link>
        </div>
      </header>
      <Suspense fallback={null}><AgentBriefing db={supabase} workspaceId={workspace.id} /></Suspense>
      <div className="grid grid-flow-dense gap-4 lg:grid-cols-3">
        {ordered.map(key => <div key={key} className={FULL.has(key) ? "min-w-0 lg:col-span-3" : WIDE.has(key) || artifactIdFromKey(key) ? "min-w-0 lg:col-span-2" : "min-w-0"}>{widgets[key]}</div>)}
      </div>
    </main>
  );
}
