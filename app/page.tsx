import Link from "next/link";
import { CoverageNote } from "@/components/coverage-note";
import { HomeLiquidity } from "./account-liquidity-summary";
import { ManualBalanceForm } from "./manual-balance-form";
import { WeeklyBriefing } from "./insights/panel";
import { CashFlowPanel, Figure, MonthCashFlow, RecentTransactions } from "./home-sections";
import { SectionFallback, card } from "./section-fallback";
import { Suspense, type ReactNode } from "react";
import { BUILTIN_WIDGETS, cardIdFromKey, homeLayout, isBuiltinWidget, sizeOptions, widgetLabel, widgetSize } from "@/lib/finance/dashboard";
import { CardSkeleton, HomeCard, type HomeCardRow } from "@/components/cards/home-card";
import { cardSize, type CardSize } from "@/lib/cards/sizes";
import { HomeGrid } from "./home-grid";
import type { QueryShared } from "@/lib/ai/artifact-data";
import { IntentLink } from "@/components/intent-link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { getSupabaseConfig } from "@/lib/env";
import { convertFx, minorDigits } from "@/lib/finance/fx";
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";
import { describeMissingInputs } from "@/lib/finance/format";
import { displayFormat } from "@/lib/display-format";
import { evaluatePlanForWorkspace } from "@/lib/finance/model";
import { SourceCoverageDetails } from "./source-coverage";
import { AgentBriefing } from "./agent-briefing";
import { HomeBudgets } from "./home-budgets";
import { HomeHistory } from "./home-history";
import { RecurringDetection, WaitingForYou, loadReview, loadWaitingForYou } from "./waiting-for-you";
import { loadPriceChanges } from "@/lib/finance/price-changes";
import { loadSourceCoverageMetadata } from "@/lib/finance/source-coverage";
import { loadWealthItems, wealthEvidence } from "@/lib/finance/wealth";
import { currentNetWorth, dayRange, loadWealthEvents, monthEnds, netWorth, netWorthSeries, removedOn, valuationHistory } from "./money/wealth/net-worth";
import { NetWorthChart } from "./net-worth-chart";
import { shownBalance } from "./money/accounts/history";
import { Phone, Sparkle } from "lucide-react";

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
  const display = displayFormat(locale, workspace.timezone);
  const { money } = display;
  const today = calendarDate(new Date(), workspace.timezone);
  const balanceEvidencePromise = loadBalanceEvidence(supabase, workspace.id);
  const allWealthPromise = loadWealthItems(supabase, workspace.id, true);
  const wealthPromise = allWealthPromise.then(items => items.filter(item => !item.removed_at));
  const sourceMetadataPromise = loadSourceCoverageMetadata(supabase, workspace.id, true);
  // Secondary widgets start inside their Suspense boundaries after the core reads finish.
  const layoutPromise = Promise.resolve(supabase.from("dashboard_layouts").select("items, version, sizes").eq("workspace_id", workspace.id).maybeSingle());
  // Include published cards hidden from Home so Add widget can restore them without rendering their bodies.
  const pinnedPromise = supabase.from("artifact_cards").select("id, artifact_id, title, size, published_version, artifacts!inner(deleted_at)").eq("workspace_id", workspace.id)
    .is("deleted_at", null).is("artifacts.deleted_at", null).not("published_version", "is", null);
  const waitingPromise = loadWaitingForYou(supabase, workspace);
  const reviewPromise = loadReview(supabase, workspace);
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
  // Split by source, as on Wealth: every account balance (overdrawn ones too), assets and investments, and debts.
  const parts = { cash: 0n, assets: 0n, debts: 0n };
  const addConverted = (amountMinor: bigint, from: string, asOf: string, source: string, name: string, part: keyof typeof parts) => {
    const rate = from === displayCurrency ? undefined : fxRates.find(row => row.from_currency === from && String(row.rate_date).slice(0, 10) <= asOf);
    try {
      const result = convertFx({ amountMinor, from, to: displayCurrency, rate: rate?.rate_text, source: rate?.source ?? source, date: rate ? String(rate.rate_date).slice(0, 10) : asOf });
      if (result.status === "available") {
        const converted = result.converted.amountMinor;
        netWorthMinor += converted; convertedCount += 1;
        parts[part] += converted;
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
  const kinds = new Map(wealthItems.map(item => [item.id, item.kind]));
  for (const valuation of valuations.included) addConverted(valuation.amountMinor, valuation.currencyCode, valuation.asOf, valuation.provenance, valuation.name, kinds.get(valuation.id) === "debt" ? "debts" : "assets");
  const accountsCounted = accounts.filter(account => account.balance.amount_minor !== null).length;
  const missing = describeMissingInputs(missingInputs);

  // Daily net worth over the last year for the chart (hover any day) and the month-end "this month" change; display currency only for now (see BACKLOG.md).
  const series = netWorthSeries({ dates: dayRange(monthEnds(today, 12)[0], today), timeZone: workspace.timezone, accountIds: new Set(accounts.map(account => account.id)),
    snapshots: balanceEvidence.snapshots, valuations: valuationHistory(wealthEvents, allWealth), removedOn: removedOn(allWealth, workspace.timezone), ledger: balanceEvidence.ledger });
  // Today's point is the headline's own inputs, so the chart ends on the number above it.
  series[series.length - 1] = currentNetWorth(today, accounts, valuations.included.map(valuation => ({ ...valuation, debt: kinds.get(valuation.id) === "debt" })));
  const trend = series.filter(point => point.known).map(point => ({ date: point.date, value: netWorth(point).get(displayCurrency) ?? 0n }));
  // The change needs last month's end on record; without it there is nothing to compare with.
  const monthBase = trend.find(point => point.date === monthEnds(today, 1)[0])?.value ?? null;
  const monthChange = monthBase === null ? 0n : trend.at(-1)!.value - monthBase;
  const { date: fullDate, dayMonth, monthYear: monthLabel } = display;
  const ago = (iso: string) => display.ago(iso, balanceEvidence.asOf);
  const dateTile = (date: string) => ({ month: display.shortMonth(date), day: date.slice(8, 10) });

  const upcoming = (projection.input?.events ?? []).filter(event => event.expectedMinor < 0n && event.source !== "estimated").sort((a, b) => a.date.localeCompare(b.date));
  const upcomingMinor = upcoming.reduce((sum, event) => sum + event.expectedMinor, 0n);
  const available = projection.available;
  const saved = homeLayout(layout.data);
  if (!saved) throw new Error("Dashboard preferences are invalid; try again");
  const cards = new Map((pinned.data ?? []).map(row => [row.id as string, row as unknown as HomeCardRow & { artifact_id: string }]));
  // A deleted artifact simply drops off Home; its key is cleaned up the next time the layout is saved.
  const ordered = saved.items.filter(key => { const id = cardIdFromKey(key); return !id || cards.has(id); });
  // Cards on one Home share their reads: the same query runs once however many cards ask for it.
  const shared: QueryShared = {};
  // Every built-in widget can be added back from the grid, so each gets a label and width; cards only once on Home.
  const keys = [...new Set([...ordered, ...[...cards.keys()].map(id => `card:${id}`), ...Object.keys(BUILTIN_WIDGETS)])];
  const sizes: Record<string, CardSize> = Object.fromEntries(keys.map(key => [key, isBuiltinWidget(key) ? widgetSize(key, saved.sizes) : cardSize(cards.get(cardIdFromKey(key)!)!.size)]));
  const labels = Object.fromEntries(keys.map(key => [key, isBuiltinWidget(key) ? widgetLabel(key) : cards.get(cardIdFromKey(key)!)!.title]));
  const sectionProps = { db: supabase, workspaceId: workspace.id, currency: displayCurrency, today, locale };

  const widgets: Record<string, ReactNode> = {
    ...Object.fromEntries([...cards.values()].map(row => [`card:${row.id}`, <Suspense key={row.id} fallback={<CardSkeleton title={row.title} />}>
      <HomeCard card={row} context={context} shared={shared} open={`/ai/artifacts/${row.artifact_id}?tab=cards`} />
    </Suspense>])),
    overview: <section aria-label="Overview" className="grid gap-4 lg:grid-cols-3">
      <div className={`${card} flex flex-col gap-5 lg:col-span-2`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5"><h2 className="text-sm font-medium">Net worth</h2>
            {convertedCount > 0 && <span className="rounded-md border border-dashed border-input px-2 py-0.5 font-mono text-[11px] text-muted-foreground">traced · {accounts.length} accounts · {valuations.included.length} valuations</span>}</div>
          <Link href="/plan/currency" className="rounded-lg border border-input px-2.5 py-1 font-mono text-xs text-muted-foreground hover:text-foreground">{displayCurrency}</Link>
        </div>
        {!accounts.length && !wealthItems.length ? <div className="space-y-3"><p className="text-sm text-muted-foreground">Three steps to see where you stand:</p><ol className="grid gap-2 text-sm sm:grid-cols-3">{([["Import a statement", "/import"], ["Or add an account by hand", "/money/accounts"], ["Confirm its current balance", "/money/accounts"]] as const).map(([step, href], index) => <li key={step}><Link href={href} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-muted"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-xs">{index + 1}</span>{step}</Link></li>)}</ol></div>
          : convertedCount > 0 ? <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1"><Figure value={money(netWorthMinor, displayCurrency)} digits={minorDigits(displayCurrency)} className="display-figure text-5xl sm:text-7xl" />
            {monthChange !== 0n && <span className="font-mono text-sm text-muted-foreground"><span className={monthChange > 0n ? "text-brand" : "text-warning"}>{monthChange > 0n ? "+" : ""}{money(monthChange, displayCurrency)}</span> this month{monthBase !== null && monthBase > 0n ? ` · ${monthChange > 0n ? "+" : ""}${(Number(monthChange * 1000n / monthBase) / 10).toFixed(1)}%` : ""}</span>}</div>
          : <p className="text-sm text-muted-foreground">Net worth unavailable in {displayCurrency}.</p>}
        {/* A partial total must say so: an account whose balance needs review is left out, not counted as zero. */}
        <CoverageNote counted={accountsCounted} total={accounts.length} />
        {missingInputs.length > 0 && <details className={`text-xs ${convertedCount ? "text-warning" : "text-muted-foreground"}`}><summary className="cursor-pointer text-brand">{convertedCount ? `Not counted: ${missing.length === 1 ? "1 item" : `${missing.length} items`}` : "See what is missing"}</summary><ul className="mt-2 list-disc space-y-1 pl-4">{missing.map(item => <li key={item}>{item}</li>)}</ul><Link href="/money/accounts" className="mt-2 mr-3 inline-block underline">Review balances</Link><Link href="/money/wealth" className="mt-2 inline-block underline">Review dated valuations</Link></details>}
        {convertedCount > 0 && trend.length > 1 && <div><NetWorthChart label={`Net worth in ${displayCurrency} at each month end`}
            points={trend.map(point => ({ date: point.date, label: point.date === today ? `Today, ${fullDate(today)}` : fullDate(point.date), amount: money(point.value, displayCurrency), y: Number(point.value) }))} />
          <p className="mt-2 flex justify-between font-mono text-[11px] text-subtle"><span>{monthLabel(trend[0].date)}</span>{trend.length > 2 && <span>{monthLabel(trend[Math.floor(trend.length / 2)].date)}</span>}<span>{monthLabel(today)}</span></p></div>}
        {convertedCount > 0 && <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-[14px] bg-border sm:grid-cols-3">
          {([["Accounts", parts.cash, "/money/accounts"], ["Investments & assets", parts.assets, "/money/wealth"], ["Debts", parts.debts, "/money/wealth"]] as const).map(([label, amount, href]) =>
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
    planning: projection.liquidity && <section aria-label="Available funds"><HomeLiquidity liquidity={projection.liquidity} accountId={accountId} names={accountNames} locale={locale} coverage={<SourceCoverageDetails coverage={projection.sourceCoverage} locale={locale} />} /></section>,
    accounts: <section aria-labelledby="home-accounts" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="home-accounts" className="text-sm font-medium"><Link href="/money/accounts" className="hover:underline">Accounts</Link></h2>
        <div className="flex gap-2"><Link href="/import" className="rounded-lg border border-input px-2.5 py-1 text-xs hover:bg-muted">Import file</Link><Link href="/import#connected-banks" className="rounded-lg border border-input px-2.5 py-1 text-xs hover:bg-muted">Connect bank</Link></div></div>
      {!accounts.length && <p className="mt-3 text-sm text-muted-foreground">No accounts yet. <Link className="text-brand underline" href="/import">Import a statement</Link> or <Link className="text-brand underline" href="/money/accounts">add one</Link>.</p>}
      <ul className="mt-3 divide-y divide-border border-t border-border">{accounts.map(account => { const { balance } = account; const isSynced = synced.has(JSON.stringify([account.name, account.currency_code])); return <li key={account.id}><article className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold">{account.name.trim().charAt(0).toUpperCase()}</span>
        <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium">{account.name}</h3><p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground"><span className="rounded border border-input px-1 font-mono text-[9px] uppercase">{isSynced ? "Bank" : "Manual"}</span>{balance.as_of ? `${isSynced ? "synced" : "set"} ${ago(balance.as_of)}` : "Add a dated balance"}</p></div>
        {(({ amount, label }) => <p className="text-right font-mono text-sm">{amount !== null ? money(amount, account.currency_code) : "Balance unknown"}{label !== "Current" && amount !== null && <span className="block font-sans text-[11px] text-muted-foreground">{balance.amount_minor === null ? `${label} · not in total` : label}</span>}</p>)(shownBalance(balance))}
        {!isSynced && <details className="w-full [&:not([open])]:-mt-1"><summary className="cursor-pointer text-xs font-medium text-brand hover:underline">Update balance</summary><div className="mt-2 rounded-lg border border-border p-3"><ManualBalanceForm account={account} snapshots={balanceEvidence.snapshots} ledger={balanceEvidence.ledger} asOf={balanceEvidence.asOf} timeZone={workspace.timezone} locale={locale} /></div></details>}
        {balance.warnings.length > 0 && <p className="w-full text-xs text-warning">{balance.warnings.join("; ")}</p>}
        {balance.status === "stale" && balance.snapshot_amount_minor !== null && <p className="w-full text-xs text-muted-foreground">Last set to {money(balance.snapshot_amount_minor, balance.currency_code)}, plus activity recorded since. Update the balance to confirm.</p>}
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
      <ul className="mt-2 divide-y divide-border">{(goals.data ?? []).map(goal => { const reservations = (allocations.data ?? []).filter(row => row.goal_id === goal.id); const comparable = reservations.every(row => accounts.find(account => account.id === row.account_id)?.currency_code === goal.currency_code); const reserved = reservations.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n); return <li key={goal.id} className="py-2 text-sm"><Link href="/plan" className="font-medium hover:underline">{goal.name}</Link><p className="text-xs text-muted-foreground">{comparable ? money(reserved, goal.currency_code) : "Reservation conversion required"} reserved of {money(goal.target_minor, goal.currency_code)}{goal.target_date ? ` · target ${fullDate(goal.target_date)}` : ""}</p></li>; })}</ul>
      {!goals.data?.length && <p className="mt-3 text-sm text-muted-foreground">No goals yet. <Link href="/plan" className="underline">Create a goal</Link>.</p>}
    </section>,
    agents: <Suspense fallback={<SectionFallback title="Agent team" />}><AgentBriefing db={supabase} workspaceId={workspace.id} timeZone={workspace.timezone} /></Suspense>,
    insights: <Suspense fallback={<SectionFallback title="Weekly briefing" />}>
      <WeeklyBriefing db={supabase} workspaceId={workspace.id} currency={displayCurrency} today={today} settings={context.settings} projection={projection} missingInputs={missingInputs} names={accountNames} wealth={wealthItems} />
    </Suspense>,
  };

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-4 px-4 py-6 text-foreground sm:px-8 lg:py-8">
      <header className="mb-2 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1"><p className="eyebrow">{display.weekday(today)} · {display.longDate(today)}</p><h1 className="page-title">Overview</h1></div>
        {/* One tap to a live call in a new chat; cards it makes land in Waiting for you. */}
        <IntentLink href="/ai?conversation=new&call=1" aria-label="Call Moneo: starts a voice call using your microphone" title="Starts a voice call in a new chat using your microphone. You can stop it at any time, or type in Ask instead." className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-medium text-primary-foreground hover:opacity-90"><Phone className="size-4" strokeWidth={1.8} aria-hidden="true" />Call Moneo</IntentLink>
      </header>
      {/* Review summaries and recurring detection stream independently; detection reloads only when a card changes. */}
      <Suspense fallback={null}><RecurringDetection supabase={supabase} workspace={workspace} /></Suspense>
      <HomeGrid version={saved.version} items={ordered} sizes={sizes} labels={labels} options={Object.fromEntries(keys.map(key => [key, sizeOptions(key)]))}
        widgets={Object.fromEntries(ordered.map(key => [key, widgets[key]]))} afterFirst={<Suspense fallback={null}><HomeAttention waiting={waitingPromise} review={reviewPromise} locale={locale} /></Suspense>} />
    </main>
  );
}

// Review summaries stream independently of the account balances and dashboard layout.
async function HomeAttention({ waiting, review, locale }: { waiting: ReturnType<typeof loadWaitingForYou>; review: ReturnType<typeof loadReview>; locale: string }) {
  const [proposals, summary] = await Promise.all([waiting, review]);
  return <WaitingForYou proposals={proposals} review={summary} locale={locale} />;
}
