import Link from "next/link";
import { Suspense } from "react";
import { z } from "zod";
import { redirect } from "next/navigation";
import { ArrowRight, CalendarDays } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { evaluatePlan } from "@/lib/finance/model";
import { calendarDate } from "@/lib/finance/calendar";
import { SourceCoverageDetails } from "@/app/source-coverage";
import { PlanningHistory } from "./history";
import { GoalPlanHistory, ReservationHistory } from "./goal-plan";
import { ForecastPreferenceEditor } from "./preferences";
import { ScenarioHistory } from "./scenarios";
import { ModelSources } from "./model-sources";
import { AccountHeadroom, planLiquidity, type LiquidityParams } from "./account-headroom";
import { ForecastView } from "./forecast";
import { GoalsSection } from "./goals";
import { WhatIfSection } from "./what-if";
import { AssumptionList } from "./assumptions";
import { button, card, eyebrow, field } from "./ui";

const pill = "inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted";

export default async function PlanPage({ searchParams }: { searchParams: Promise<LiquidityParams> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const params = await searchParams;
  const requestedHorizon = z.coerce.number().int().min(1).max(365).safeParse(params.horizon ?? 30);
  const horizon = requestedHorizon.success ? requestedHorizon.data : 30;
  // The real-plan forecast loads alongside the page's own rows; only a selected scenario waits for them.
  const [realPlan, { data: goals }, { data: allocations }, { data: accounts }, { data: assumptions, error: assumptionsError }, { data: scenarios }] = await Promise.all([
    evaluatePlan(horizon),
    supabase.from("goals").select("id, name, target_minor::text, currency_code, target_date, priority, status, notes, version, planned_monthly_minor::text, contribution_starts_on, recorded_saved_minor::text, saved_as_of")
      .eq("workspace_id", workspace.id).order("priority").order("created_at", { ascending: false }),
    supabase.from("goal_allocations").select("id, goal_id, account_id, amount_minor::text, version").eq("workspace_id", workspace.id),
    supabase.from("accounts").select("id, name, currency_code, type, archived_at").eq("workspace_id", workspace.id).order("name"),
    supabase.from("financial_assumptions").select("id, account_id, name, amount_minor::text, currency_code, cadence, starts_on, schedule_anchor_on, ends_on, source, confidence, confirmed, enabled, version")
      .eq("workspace_id", workspace.id).is("removed_at", null).order("created_at", { ascending: false }),
    supabase.from("scenarios").select("id, name, description, version").eq("workspace_id", workspace.id).is("removed_at", null).order("created_at", { ascending: false }),
  ]);
  const accountNames = new Map((accounts ?? []).map(account => [account.id, account.name]));
  const activeAccounts = (accounts ?? []).filter(account => !account.archived_at);
  const selectedScenario = scenarios?.find(item => item.id === params.scenario);
  const scenarioId = selectedScenario?.id;
  const realProjection = scenarioId ? await evaluatePlan(horizon, scenarioId) : realPlan;
  const liquidityParams = { ...params, horizon: String(horizon), scenario: scenarioId };
  const result = planLiquidity(realProjection.input, liquidityParams);
  const projection = { ...realProjection, forecast: result.forecast, available: result.liquidity.status === "available" ? result.liquidity.aggregate : result.liquidity };
  const baseline = scenarioId ? realPlan : projection;
  const scenarioHref = (id?: string) => {
    const query = new URLSearchParams(Object.entries(liquidityParams).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (id) query.set("scenario", id); else query.delete("scenario");
    return `/plan?${query}`;
  };
  const today = calendarDate(new Date(), workspace.timezone);
  const currency = workspace.display_currency;
  const input = realProjection.input;

  return <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 text-foreground sm:px-8 lg:py-10">
    {!requestedHorizon.success && <p role="alert">Choose a whole forecast horizon from 1 to 365 days. Showing 30 days.</p>}
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="font-mono text-xs font-medium uppercase tracking-[0.16em] text-brand">Financial planning</p><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Plan</h1><p className="mt-2 text-sm text-muted-foreground">Where your cash is heading, what is due, and what your goals need.</p></div>
      <nav aria-label="Planning tools" className="flex flex-wrap gap-2"><Link href="/plan/spending" className={pill}>Spending limits <ArrowRight className="size-4" /></Link><Link href="/plan/currency" className={pill}>Currency <ArrowRight className="size-4" /></Link></nav>
    </header>
    <Suspense><ForecastPreferenceEditor preferences={projection.preferences} version={projection.preferencesVersion} accounts={activeAccounts} today={today} /></Suspense>
    <section className={card} aria-labelledby="forecast-heading">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><p className={eyebrow}>Projection{selectedScenario ? ` · ${selectedScenario.name}` : ""}</p><h2 id="forecast-heading" className="mt-1 text-base font-semibold">Liquid balance horizon</h2></div>
        <form method="get" className="flex flex-wrap items-end gap-2"><label className="grid gap-1 text-xs font-medium text-muted-foreground">Horizon in days <input name="horizon" type="number" min="1" max="365" defaultValue={horizon} className={field + " w-24 font-mono"} /></label>{Object.entries(liquidityParams).filter(([key, value]) => key !== "horizon" && value !== undefined).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}<button className={button}><CalendarDays className="size-4" />Update</button></form></div>
      {projection.forecast.status === "available" && <ForecastView days={projection.forecast.days} events={[...input.events, ...(input.scenarioEvents ?? [])]} currency={input.currencyCode} locale={workspace.locale} names={accountNames}
        compare={scenarioId && baseline.forecast.status === "available" ? { name: "Real plan", days: baseline.forecast.days } : undefined} />}
      <div className="border-t border-border pt-4"><AccountHeadroom input={input} params={liquidityParams} names={accountNames} locale={workspace.locale} result={result} /></div>
      <SourceCoverageDetails coverage={baseline.sourceCoverage} />
    </section>
    <WhatIfSection scenarios={scenarios ?? []} selected={selectedScenario} href={scenarioHref} real={baseline} scenario={projection} accounts={activeAccounts} currency={currency} locale={workspace.locale} today={today} horizon={horizon} />
    <GoalsSection goals={goals ?? []} allocations={allocations ?? []} accounts={accounts ?? []} currency={currency} locale={workspace.locale} today={today} />
    <section className={card} aria-labelledby="financial-model"><div><p className={eyebrow}>Inputs</p><h2 id="financial-model" className="mt-1 text-base font-semibold">Financial model</h2><p className="mt-1 text-sm text-muted-foreground">Income and expenses that shape your forecast. Positive amounts add cash; negative amounts spend it.</p></div>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading sources…</p>}><ModelSources db={supabase} workspace={workspace} /></Suspense>
      <AssumptionList assumptions={assumptions ?? []} error={assumptionsError?.message} accounts={activeAccounts} names={accountNames} locale={workspace.locale} today={today} />
    </section>
    <section aria-labelledby="history-heading" className="space-y-3"><h2 id="history-heading" className="text-sm font-semibold text-muted-foreground">History and undo</h2>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading history…</p>}>
        <GoalPlanHistory goals={goals ?? []} />
        <ReservationHistory goals={goals ?? []} allocations={allocations ?? []} />
        <ScenarioHistory />
        <PlanningHistory entityType="assumption" destination="/plan" />
      </Suspense>
    </section>
  </main>;
}
