import Link from "next/link";
import { HomeLiquidity } from "./account-liquidity-summary";
import { ManualBalanceForm } from "./manual-balance-form";
import { WeeklyBriefing, loadInsightEvidence } from "./insights/panel";
import { CashFlowPanel, Figure, MonthCashFlow, RecentTransactions, SectionFallback, card } from "./home-sections";
import { Suspense, type ReactNode } from "react";
import { BUILTIN_WIDGETS, artifactIdFromKey, dashboardItems, dashboardLayoutSchema } from "@/lib/finance/dashboard";
import { HomeGrid } from "./home-grid";
import { ArtifactFrame } from "@/components/artifact-frame";
import { loadHomeSpending } from "@/lib/finance/dashboard-spending";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { getSupabaseConfig } from "@/lib/env";
import { convertFx, minorDigits } from "@/lib/finance/fx";
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";
import { describeMissingInputs, formatMoney } from "@/lib/finance/format";
import { evaluatePlanForWorkspace } from "@/lib/finance/model";
import { SourceCoverageDetails } from "./source-coverage";
import { AgentBriefing, loadAgentBriefing } from "./agent-briefing";
import { HomeBudgets } from "./home-budgets";
import { HomeHistory, loadHomeHistory } from "./home-history";
import { IouReview, loadIouReview } from "./iou-review";
import { RecurringReview } from "./money/recurring/review";
import { loadPriceChanges } from "@/lib/finance/price-changes";
import { loadSourceCoverageMetadata } from "@/lib/finance/source-coverage";
import { loadWealthItems, wealthEvidence } from "@/lib/finance/wealth";
import { dayRange, loadWealthEvents, monthEnds, netWorth, netWorthSeries, removedOn, valuationHistory } from "./money/wealth/net-worth";
import { NetWorthChart } from "./net-worth-chart";
import { Sparkle } from "lucide-react";

// Six columns: a wide card pairs with a narrow one and half cards pair up; dense flow fills the gaps whatever order the layout picks.
const FULL = new Set(["overview", "history"]);
const WIDE = new Set(["spending", "insights", "recent"]);
const HALF = new Set(["accounts", "agents"]);
const span = (key: string) => FULL.has(key) ? "lg:col-span-6" : WIDE.has(key) || artifactIdFromKey(key) ? "lg:col-span-4" : HALF.has(key) ? "lg:col-span-3" : "lg:col-span-2";

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
  const allWealthPromise = loadWealthItems(supabase, workspace.id, true);
  const wealthPromise = allWealthPromise.then(items => items.filter(item => !item.removed_at));
  const sourceMetadataPromise = loadSourceCoverageMetadata(supabase, workspace.id, true);
  // Start the streamed sections' reads now (memoized); their Suspense boundaries pick up the same promises.
  loadInsightEvidence(supabase, workspace.id, displayCurrency, today).catch(() => undefined);
  loadHomeSpending(supabase, workspace.id, displayCurrency, today).catch(() => undefined);
  loadHomeHistory(supabase, workspace.id).catch(() => undefined);
  loadAgentBriefing(supabase, workspace.id).catch(() => undefined);
  loadIouReview(supabase, workspace.id);
  const layoutPromise = Promise.resolve(supabase.from("dashboard_layouts").select("items, version").eq("workspace_id", workspace.id).maybeSingle());
  // Pinned artifact titles chain onto the layout read, so they finish inside the slower forecast; the frames load their data themselves.
  const pinnedPromise = layoutPromise.then(async ({ data }) => {
    const ids = (Array.isArray(data?.items) ? data.items : []).map(artifactIdFromKey).filter(id => id !== null);
    return ids.length ? supabase.from("artifacts").select("id, title").eq("workspace_id", workspace.id).in("id", ids).is("deleted_at", null) : { data: [], error: null };
  });
  const [balanceEvidence, projection, wealthItems, rates, layout, pinned, goals, allocations, sourceMetadata, allWealth, wealthEvents, bankAccounts, priceChanges] = await Promise.all([
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
    supabase.from("bank_connection_accounts").select("account_name, currency_code").eq("workspace_id", workspace.id),
    // Price labels are a nicety; Coming up still renders without them.
    loadPriceChanges(supabase, workspace.id).catch(() => new Map<string, never>()),
  ]);
  for (const error of [rates.error, layout.error, pinned.error, goals.error, allocations.error, bankAccounts.error]) if (error) throw error;
  // A bank sync imports into the account with the bank's name and currency, as on the Accounts page.
  const synced = new Set((bankAccounts.data ?? []).map(connected => JSON.stringify([connected.account_name, connected.currency_code])));
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

  // Daily net worth over the last year for the chart (hover any day) and the month-end "this month" change; display currency only for now (see BACKLOG.md).
  const trend = netWorthSeries({ dates: dayRange(monthEnds(today, 12)[0], today), timeZone: workspace.timezone, accountIds: new Set(accounts.map(account => account.id)),
    snapshots: balanceEvidence.snapshots, valuations: valuationHistory(wealthEvents, allWealth), removedOn: removedOn(allWealth, workspace.timezone), ledger: balanceEvidence.ledger })
    .filter(point => point.known).map(point => ({ date: point.date, value: netWorth(point).get(displayCurrency) ?? 0n }));
  // The change needs last month's end on record; without it there is nothing to compare with.
  const monthBase = trend.find(point => point.date === monthEnds(today, 1)[0])?.value ?? null;
  const monthChange = monthBase === null ? 0n : trend.at(-1)!.value - monthBase;
  const fullDate = (date: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const dayMonth = (date: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const ago = (iso: string) => {
    const minutes = Math.round((Date.parse(balanceEvidence.asOf) - Date.parse(iso)) / 60000), format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    return minutes < 60 ? format.format(-Math.max(minutes, 0), "minute") : minutes < 1440 ? format.format(-Math.round(minutes / 60), "hour") : format.format(-Math.round(minutes / 1440), "day");
  };
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

  const widgets: Record<string, ReactNode> = {
    ...Object.fromEntries([...pinnedTitles].map(([id, title]) => [`artifact:${id}`, <section key={id} aria-label={title} className={`${card} flex flex-col gap-3`}>
      <div className="flex items-baseline justify-between gap-2"><h2 className="truncate text-sm font-medium">{title}</h2><Link href={`/ai/artifacts/${id}`} className="shrink-0 text-sm font-medium text-brand hover:underline">Open</Link></div>
      <ArtifactFrame src={`/ai/artifacts/${id}/frame?view=widget`} title={title} theme={context.settings.theme} loading="lazy" fit className="w-full" />
    </section>])),
    overview: <section aria-label="Overview" className="grid gap-4 lg:grid-cols-3">
      <div className={`${card} flex flex-col gap-5 lg:col-span-2`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5"><h2 className="text-sm font-medium">Net worth</h2>
            {convertedCount > 0 && <span className="rounded-md border border-dashed border-input px-2 py-0.5 font-mono text-[11px] text-muted-foreground">traced · {accounts.length} accounts · {valuations.included.length} valuations</span>}</div>
          <Link href="/plan/currency" className="rounded-lg border border-input px-2.5 py-1 font-mono text-xs text-muted-foreground hover:text-foreground">{displayCurrency}</Link>
        </div>
        {!accounts.length && !wealthItems.length ? <p className="text-sm text-muted-foreground">Add an account to see your net worth.</p>
          : convertedCount > 0 ? <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1"><Figure value={money(netWorthMinor, displayCurrency)} digits={minorDigits(displayCurrency)} className="display-figure text-5xl sm:text-7xl" />
            {monthChange !== 0n && <span className="font-mono text-sm text-muted-foreground"><span className={monthChange > 0n ? "text-brand" : "text-warning"}>{monthChange > 0n ? "+" : ""}{money(monthChange, displayCurrency)}</span> this month{monthBase !== null && monthBase > 0n ? ` · ${monthChange > 0n ? "+" : ""}${(Number(monthChange * 1000n / monthBase) / 10).toFixed(1)}%` : ""}</span>}</div>
          : <p className="text-sm text-muted-foreground">Net worth unavailable in {displayCurrency}.</p>}
        {convertedCount === 0 && missingInputs.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer text-brand">See what is missing</summary><ul className="mt-2 list-disc space-y-1 pl-4">{describeMissingInputs(missingInputs).map(item => <li key={item}>{item}</li>)}</ul><Link href="/money/wealth" className="mt-2 inline-block underline">Review dated valuations</Link></details>}
        {convertedCount > 0 && trend.length > 1 && <div><NetWorthChart label={`Net worth in ${displayCurrency} at each month end`}
            points={trend.map(point => ({ date: point.date, label: point.date === today ? `Today, ${fullDate(today)}` : fullDate(point.date), amount: money(point.value, displayCurrency), y: Number(point.value) }))} />
          <p className="mt-2 flex justify-between font-mono text-[11px] text-subtle"><span>{monthLabel(trend[0].date)}</span>{trend.length > 2 && <span>{monthLabel(trend[Math.floor(trend.length / 2)].date)}</span>}<span>{monthLabel(today)}</span></p></div>}
        {convertedCount > 0 && <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-[14px] bg-border sm:grid-cols-3">
          {([["Cash & accounts", parts.cash, "/money/accounts"], ["Assets", parts.assets, "/money/wealth"], ["Debts", parts.debts, "/money/wealth"]] as const).map(([label, amount, href]) =>
            <div key={label} className="bg-card"><Link href={href} className="flex flex-col gap-1 px-4 py-3.5 hover:bg-muted"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-mono">{money(amount, displayCurrency)}</dd></Link></div>)}
        </dl>}
      </div>
      <Suspense fallback={<SectionFallback title="This month" />}><MonthCashFlow {...sectionProps}>
        {available?.status === "available" && <Link href="/plan" className="mt-auto flex flex-col gap-1.5 rounded-[14px] border border-ai-border bg-ai-soft p-3.5 hover:border-ai">
          <p className="flex items-center gap-2 text-xs text-ai"><Sparkle className="size-3.5 fill-current" aria-hidden="true" />Cash-flow forecaster</p>
          <p className="text-[13px]">Lowest point after your buffer: <span className={`font-mono ${available.amountMinor < 0n ? "text-warning" : ""}`}>{money(available.amountMinor, displayCurrency)}</span> on {dayMonth(available.limitingDate)}.</p>
        </Link>}
      </MonthCashFlow></Suspense>
    </section>,
    spending: <Suspense fallback={<SectionFallback title="Cash flow · 6 months" />}><CashFlowPanel {...sectionProps} /></Suspense>,
    recent: <Suspense fallback={<SectionFallback title="Recent transactions" />}><RecentTransactions db={supabase} workspaceId={workspace.id} locale={locale} names={accountNames} /></Suspense>,
    planning: projection.liquidity && <section aria-label="Available funds"><HomeLiquidity liquidity={projection.liquidity} accountId={accountId} names={accountNames} locale={locale} coverage={<SourceCoverageDetails coverage={projection.sourceCoverage} />} /></section>,
    accounts: <section aria-labelledby="home-accounts" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="home-accounts" className="text-sm font-medium"><Link href="/money/accounts" className="hover:underline">Accounts</Link></h2>
        <div className="flex gap-2"><Link href="/import" className="rounded-lg border border-input px-2.5 py-1 text-xs hover:bg-muted">Import file</Link><Link href="/import#connected-banks" className="rounded-lg border border-input px-2.5 py-1 text-xs hover:bg-muted">Connect bank</Link></div></div>
      {!accounts.length && <p className="mt-3 text-sm text-muted-foreground">No accounts yet. <Link className="text-brand underline" href="/import">Import a statement</Link> or <Link className="text-brand underline" href="/money/accounts">add one</Link>.</p>}
      <ul className="mt-3 divide-y divide-border border-t border-border">{accounts.map(account => { const { balance } = account; const isSynced = synced.has(JSON.stringify([account.name, account.currency_code])); return <li key={account.id}><article className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold">{account.name.trim().charAt(0).toUpperCase()}</span>
        <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium">{account.name}</h3><p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground"><span className="rounded border border-input px-1 font-mono text-[9px] uppercase">{isSynced ? "Bank" : "Manual"}</span>{balance.as_of ? `${isSynced ? "synced" : "set"} ${ago(balance.as_of)}` : "Add a dated balance"}</p></div>
        <p className="font-mono text-sm">{balance.snapshot_amount_minor !== null ? money(balance.snapshot_amount_minor, balance.snapshot_currency_code!) : "Balance unknown"}</p>
        {!isSynced && <details className="w-full [&:not([open])]:-mt-1"><summary className="cursor-pointer text-xs font-medium text-brand hover:underline">Update balance</summary><div className="mt-2 rounded-lg border border-border p-3"><ManualBalanceForm account={account} snapshots={balanceEvidence.snapshots} ledger={balanceEvidence.ledger} asOf={balanceEvidence.asOf} timeZone={workspace.timezone} locale={locale} /></div></details>}
        {balance.warnings.length > 0 && <p className="w-full text-xs text-warning">{balance.warnings.join("; ")}</p>}
        {balance.status === "stale" && balance.estimated_amount_minor !== null && <p className="w-full text-xs text-muted-foreground">Recent activity suggests about {money(balance.estimated_amount_minor, balance.currency_code)}. Update the balance to confirm.</p>}
      </article></li>; })}</ul>
    </section>,
    upcoming: <section aria-labelledby="home-upcoming" className={card}>
      <div className="flex items-baseline justify-between gap-2"><h2 id="home-upcoming" className="text-sm font-medium"><Link href="/money/recurring" className="hover:underline">Coming up</Link></h2>
        {upcoming.length > 0 && <span className="font-mono text-[11px] text-subtle">{money(-upcomingMinor, displayCurrency)} · {projection.input?.horizonDays ?? 30} days</span>}</div>
      {upcoming.length ? <ul className="mt-3 divide-y divide-border">{upcoming.slice(0, 6).map((event, index) => <li key={`${event.accountId}:${event.date}:${index}`} className="flex items-center gap-3 py-3">
        <span className="flex w-10 shrink-0 flex-col items-center rounded-lg border border-border py-1 leading-none"><span className="font-mono text-[9px] uppercase text-subtle">{dateTile(event.date).month}</span><span className="mt-0.5 font-mono text-[15px] font-semibold">{dateTile(event.date).day}</span></span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{event.name ?? "Confirmed payment"}</span><span className="block truncate text-xs text-muted-foreground">{(price => price ? <span className={price.changeMinor > 0n ? "text-warning" : "text-brand"}>Price {price.changeMinor > 0n ? "up" : "down"} {money(price.changeMinor > 0n ? price.changeMinor : -price.changeMinor, price.currencyCode)}</span>
          : <>{event.source === "debt" ? "Loan payment" : "Recurring"} · {accountNames.get(event.accountId) ?? "Account"}</>)(priceChanges.get(`${event.accountId}:${event.name}`))}</span></span>
        <span className="shrink-0 font-mono text-sm">{money(event.expectedMinor, displayCurrency)}</span></li>)}</ul>
        : <p className="mt-3 text-sm text-muted-foreground">No confirmed payments in the next {projection.input?.horizonDays ?? 30} days.</p>}
    </section>,
    history: <Suspense fallback={null}><HomeHistory db={supabase} workspaceId={workspace.id} locale={locale} timeZone={workspace.timezone} names={accountNames} /></Suspense>,
    budgets: <Suspense fallback={<SectionFallback title="Budgets" />}><HomeBudgets {...sectionProps} /></Suspense>,
    goals: <section className={card}>
      <div className="flex items-baseline justify-between gap-2"><h2 className="text-sm font-medium">Goals</h2><Link href="/plan" className="text-sm font-medium text-brand hover:underline">Plan</Link></div>
      <p className="mt-1 text-xs text-muted-foreground">Reserving money for a goal does not move it.</p>
      <ul className="mt-2 divide-y divide-border">{(goals.data ?? []).map(goal => { const reservations = (allocations.data ?? []).filter(row => row.goal_id === goal.id); const comparable = reservations.every(row => accounts.find(account => account.id === row.account_id)?.currency_code === goal.currency_code); const reserved = reservations.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n); return <li key={goal.id} className="py-2 text-sm"><Link href="/plan" className="font-medium hover:underline">{goal.name}</Link><p className="text-xs text-muted-foreground">{comparable ? money(reserved, goal.currency_code) : "Reservation conversion required"} reserved of {money(goal.target_minor, goal.currency_code)}{goal.target_date ? ` · target ${goal.target_date}` : ""}</p></li>; })}</ul>
      {!goals.data?.length && <p className="mt-3 text-sm text-muted-foreground">No goals yet. <Link href="/plan" className="underline">Create a goal</Link>.</p>}
    </section>,
    agents: <Suspense fallback={<SectionFallback title="Agent team" />}><AgentBriefing db={supabase} workspaceId={workspace.id} timeZone={workspace.timezone} /></Suspense>,
    insights: <Suspense fallback={<SectionFallback title="Weekly briefing" />}>
      <WeeklyBriefing db={supabase} workspaceId={workspace.id} currency={displayCurrency} today={today} settings={context.settings} projection={projection} missingInputs={missingInputs} names={accountNames} wealth={wealthItems} />
    </Suspense>,
  };

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-4 px-4 py-6 text-foreground sm:px-8 lg:py-8">
      <HomeGrid version={layout.data?.version ?? 0} widgets={ordered.map(key => ({ key, span: span(key), node: widgets[key], label: pinnedTitles.get(artifactIdFromKey(key) ?? "") ?? BUILTIN_WIDGETS[key as keyof typeof BUILTIN_WIDGETS] }))}
        heading={<div className="flex flex-col gap-1"><p className="eyebrow">{new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(`${today}T00:00:00Z`))} · {new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${today}T00:00:00Z`))}</p><h1 className="page-title">Overview</h1></div>}>
        <Suspense fallback={null}><IouReview db={supabase} workspaceId={workspace.id} /></Suspense>
        <Suspense fallback={null}><RecurringReview supabase={supabase} workspace={workspace} /></Suspense>
      </HomeGrid>
    </main>
  );
}
