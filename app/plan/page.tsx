import Link from "next/link";
import { Suspense } from "react";
import { z } from "zod";
import { redirect } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { accountLiquidity, availableToSpend, forecastDaily, usableForecastInput } from "@/lib/finance/calculations";
import { evaluatePlan } from "@/lib/finance/model";
import { CoverageNote } from "@/components/coverage-note";
import { calendarDate } from "@/lib/finance/calendar";
import { SourceCoverageDetails } from "@/app/source-coverage";
import { PlanningHistory } from "./history";
import { GoalPlanHistory, ReservationHistory } from "./goal-plan";
import { ForecastPreferenceEditor } from "./preferences";
import { ScenarioHistory } from "./scenarios";
import { ModelSources } from "./model-sources";
import { AccountHeadroom, planLiquidity, type LiquidityParams } from "./account-headroom";
import { ForecastBlockers, forecastBlockers } from "./blockers";
import { ForecastView } from "./forecast";
import { GoalsSection } from "./goals";
import { WhatIfSection } from "./what-if";
import { AssumptionList } from "./assumptions";
import { button, card, eyebrow, field } from "./ui";

export const metadata = { title: "Plan" };

const pill = "inline-flex h-11 items-center gap-1 rounded-xl border border-input px-4 text-[13px] font-medium hover:bg-muted";

type Plan = Awaited<ReturnType<typeof evaluatePlan>>;
/** The forecast from the accounts it can use, with the ones left out named on the page. */
function fromUsableAccounts(plan: Plan): Plan {
  const { input, excluded } = usableForecastInput(plan.input);
  return excluded.length ? { ...plan, input, forecast: forecastDaily(input), available: availableToSpend(input), liquidity: accountLiquidity(input) } : plan;
}

export default async function PlanPage({ searchParams }: { searchParams: Promise<LiquidityParams & { removed?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const { removed, ...params } = await searchParams;
  const requestedHorizon = z.coerce.number().int().min(1).max(365).safeParse(params.horizon ?? 30);
  const horizon = requestedHorizon.success ? requestedHorizon.data : 30;
  // The real-plan forecast loads alongside the page's own rows; only a selected scenario waits for them.
  const [realPlan, { data: goals, error: goalsError }, { data: allocations, error: allocationsError }, { data: accounts, error: accountsError }, { data: assumptions, error: assumptionsError }, { data: scenarios, error: scenariosError }] = await Promise.all([
    evaluatePlan(horizon),
    supabase.from("goals").select("id, name, target_minor::text, currency_code, target_date, priority, status, notes, version, planned_monthly_minor::text, contribution_starts_on, recorded_saved_minor::text, saved_as_of")
      .eq("workspace_id", workspace.id).order("priority").order("created_at", { ascending: false }),
    supabase.from("goal_allocations").select("id, goal_id, account_id, amount_minor::text, version").eq("workspace_id", workspace.id),
    supabase.from("accounts").select("id, name, currency_code, type, archived_at").eq("workspace_id", workspace.id).order("name"),
    supabase.from("financial_assumptions").select("id, account_id, name, amount_minor::text, currency_code, cadence, starts_on, schedule_anchor_on, ends_on, source, confidence, confirmed, enabled, version")
      .eq("workspace_id", workspace.id).is("removed_at", null).order("created_at", { ascending: false }),
    supabase.from("scenarios").select("id, name, description, version").eq("workspace_id", workspace.id).is("removed_at", null).order("created_at", { ascending: false }),
  ]);
  // A failed read must not look like having no goals or accounts: the error page offers a retry instead.
  const planError = goalsError ?? allocationsError ?? accountsError ?? scenariosError;
  if (planError) throw new Error("Plan data could not be loaded");
  const accountNames = new Map((accounts ?? []).map(account => [account.id, account.name]));
  const activeAccounts = (accounts ?? []).filter(account => !account.archived_at);
  const selectedScenario = scenarios?.find(item => item.id === params.scenario);
  const scenarioId = selectedScenario?.id;
  const realUsable = fromUsableAccounts(realPlan);
  const fullProjection = scenarioId ? await evaluatePlan(horizon, scenarioId) : realPlan;
  const realProjection = scenarioId ? fromUsableAccounts(fullProjection) : realUsable;
  const leftOut = fullProjection.input.accounts.filter(account => !realProjection.input.accounts.some(used => used.id === account.id));
  const liquidityParams = { ...params, horizon: String(horizon), scenario: scenarioId };
  const result = planLiquidity(realProjection.input, liquidityParams);
  const projection = { ...realProjection, forecast: result.forecast, available: result.liquidity.status === "available" ? result.liquidity.aggregate : result.liquidity };
  const baseline = scenarioId ? realUsable : projection;
  const scenarioHref = (id?: string) => {
    const query = new URLSearchParams(Object.entries(liquidityParams).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (id) query.set("scenario", id); else query.delete("scenario");
    return `/plan?${query}`;
  };
  const today = calendarDate(new Date(), workspace.timezone);
  const currency = workspace.display_currency;
  const input = realProjection.input;
  const blockers = forecastBlockers([...(fullProjection.input.missingInputs ?? []), ...leftOut.filter(account => account.availableMinor == null && account.balanceMinor === null).map(account => `balance:${account.id}`), ...(result.liquidity.status === "unavailable" ? result.liquidity.missingInputs : [])], fullProjection.input.accounts, accountNames);

  return <main className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-6 text-foreground sm:px-8 lg:py-8">
    {!requestedHorizon.success && <p role="alert">Choose a whole forecast horizon from 1 to 365 days. Showing 30 days.</p>}
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1"><p className="eyebrow">Forecast · {horizon} days · display currency {currency}</p><h1 className="page-title">Plan</h1><p className="mt-1 text-sm text-muted-foreground">Where your cash is heading, what is due, and what your goals need.</p></div>
      <nav aria-label="Planning tools" className="flex flex-wrap gap-2"><a href="#forecast-heading" className={pill}>Forecast</a><a href="#goals-heading" className={pill}>Goals</a><a href="#financial-model" className={pill}>Inputs</a><a href="#history-heading" className={pill}>History</a><a href="#what-if" className={`${pill} border-transparent bg-primary text-primary-foreground hover:bg-primary hover:opacity-90`}>New scenario</a></nav>
    </header>
    {selectedScenario && <p role="status" className="rounded-lg bg-muted/60 px-4 py-3 text-sm">Viewing hypothetical scenario: <span className="font-medium">{selectedScenario.name}</span>. <Link href={scenarioHref()} className="font-medium text-brand underline">Back to real plan</Link></p>}
    {params.scenario && !selectedScenario && <p role="status" className="rounded-lg bg-muted/60 px-4 py-3 text-sm">This scenario is unavailable. Showing your real plan. <a href="#what-if" className="font-medium text-brand underline">See your scenarios</a></p>}
    <section className={card} aria-labelledby="forecast-heading">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><p className={eyebrow}>Projection{selectedScenario ? ` · ${selectedScenario.name}` : ""}</p><h2 id="forecast-heading" className="mt-1 scroll-mt-24 text-sm font-medium">Your cash over the next {horizon === 1 ? "day" : `${horizon} days`}</h2></div>
        <form method="get" className="flex flex-wrap items-end gap-2"><label className="grid gap-1 text-xs font-medium text-muted-foreground">Horizon in days <input name="horizon" type="number" min="1" max="365" defaultValue={horizon} className={field + " w-24 font-mono"} /></label>{Object.entries(liquidityParams).filter(([key, value]) => key !== "horizon" && value !== undefined).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}<button className={button}><CalendarDays className="size-4" />Update</button></form></div>
      {leftOut.length > 0 && <CoverageNote counted={input.accounts.length} total={fullProjection.input.accounts.length} />}
      {blockers.length > 0 && <ForecastBlockers blockers={blockers} unavailable={result.liquidity.status === "unavailable"} />}
      {projection.forecast.status === "available" && <ForecastView days={projection.forecast.days} events={[...input.events, ...(input.scenarioEvents ?? [])]} currency={input.currencyCode} locale={workspace.locale} names={accountNames}
        compare={scenarioId && baseline.forecast.status === "available" ? { name: "Real plan", days: baseline.forecast.days } : undefined} />}
      <div className="border-t border-border pt-4"><AccountHeadroom input={input} params={liquidityParams} names={accountNames} locale={workspace.locale} result={result} /></div>
      <SourceCoverageDetails coverage={baseline.sourceCoverage} />
    </section>
    <Suspense><ForecastPreferenceEditor preferences={projection.preferences} version={projection.preferencesVersion} accounts={activeAccounts} today={today} /></Suspense>
    <WhatIfSection scenarios={scenarios ?? []} selected={selectedScenario} href={scenarioHref} real={baseline} scenario={projection} accounts={activeAccounts} currency={currency} locale={workspace.locale} today={today} horizon={horizon} />
    <GoalsSection goals={goals ?? []} allocations={allocations ?? []} accounts={accounts ?? []} currency={currency} locale={workspace.locale} today={today} />
    <section className={card} aria-labelledby="financial-model"><div><p className={eyebrow}>Inputs</p><h2 id="financial-model" className="mt-1 scroll-mt-24 text-sm font-medium">Financial model</h2><p className="mt-1 text-sm text-muted-foreground">Income and expenses that shape your forecast. Choose Income or Expense and enter a plain amount.</p></div>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading sources…</p>}><ModelSources db={supabase} workspace={workspace} /></Suspense>
      <AssumptionList assumptions={assumptions ?? []} error={assumptionsError?.message} accounts={activeAccounts} names={accountNames} locale={workspace.locale} today={today} />
    </section>
    <section aria-labelledby="history-heading" className="space-y-3"><h2 id="history-heading" className="scroll-mt-24 font-display text-2xl font-semibold tracking-tight">History and undo</h2>
      {removed === "assumption" && <p role="status" className="text-sm">Assumption removed and no longer used in your forecast. Use Undo under Financial model history to bring it back.</p>}
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading history…</p>}>
        <GoalPlanHistory goals={goals ?? []} />
        <ReservationHistory goals={goals ?? []} allocations={allocations ?? []} />
        <ScenarioHistory />
        <PlanningHistory entityType="assumption" destination="/plan" open={removed === "assumption"} />
      </Suspense>
    </section>
  </main>;
}
