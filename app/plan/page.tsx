import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { evaluatePlan } from "@/lib/finance/model";
import { formatMoney, formatInputAmount } from "@/lib/finance/format";
import { addAssumption, addScenarioEvent, createGoal, createScenario, deleteAssumption, setAllocation, undoReservation, toggleAssumption, updateAssumption } from "./actions";
import { ArrowRight, CalendarDays } from "lucide-react";
import { PlanningHistory } from "./history";
import { calendarDate } from "@/lib/finance/calendar";
import { goalContributionProjection } from "@/lib/finance/goals";
import { GoalPlanEditor, GoalPlanHistory } from "./goal-plan";

const field = "min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/15";
const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90";
const card = "rounded-xl border border-border bg-card p-5 shadow-sm";

function ForecastChart({ days }: { days: { date: string; expectedMinor: bigint; conservativeMinor: bigint; optimisticMinor: bigint }[] }) {
  if (!days.length) return null;
  const values = days.flatMap(day => [Number(day.expectedMinor), Number(day.conservativeMinor), Number(day.optimisticMinor)]);
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  const points = (key: "expectedMinor" | "conservativeMinor" | "optimisticMinor") => days.map((day, index) =>
    `${24 + index * 952 / Math.max(1, days.length - 1)},${176 - (Number(day[key]) - low) * 144 / span}`).join(" ");
  return <div className="mt-6 overflow-hidden rounded-lg bg-muted/70 px-3 pt-5 pb-3">
    <svg viewBox="0 0 1000 200" className="h-52 w-full" preserveAspectRatio="none" role="img" aria-label="Expected, conservative, and optimistic balance over the selected horizon">
      {[32, 80, 128, 176].map(y => <line key={y} x1="24" x2="976" y1={y} y2={y} stroke="#dce5f2" strokeDasharray="4 5" />)}
      <polyline points={points("optimisticMinor")} fill="none" stroke="#86a7ed" strokeWidth="2" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
      <polyline points={points("conservativeMinor")} fill="none" stroke="#7590ad" strokeWidth="2" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
      <polyline points={points("expectedMinor")} fill="none" stroke="#0051d5" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="flex justify-between px-2 font-mono text-[11px] text-muted-foreground"><span>{days[0].date}</span><span>{days.at(-1)!.date}</span></div>
  </div>;
}

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ horizon?: string; scenario?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const params = await searchParams;
  const horizon = Math.min(365, Math.max(1, Number(params.horizon) || 30));
  const [{ data: goals }, { data: allocations }, { data: accounts }, { data: assumptions, error: assumptionsError }, { data: scenarios }] = await Promise.all([
    supabase.from("goals").select("id, name, target_minor::text, currency_code, target_date, priority, status, notes, version, planned_monthly_minor::text, contribution_starts_on, recorded_saved_minor::text, saved_as_of")
      .eq("workspace_id", workspace.id).order("priority").order("created_at", { ascending: false }),
    supabase.from("goal_allocations").select("id, goal_id, account_id, amount_minor::text, version").eq("workspace_id", workspace.id),
    supabase.from("accounts").select("id, name, currency_code, type").eq("workspace_id", workspace.id).order("name"),
    supabase.from("financial_assumptions").select("id, account_id, name, amount_minor::text, currency_code, cadence, starts_on, ends_on, source, confidence, confirmed, enabled, version")
      .eq("workspace_id", workspace.id).is("removed_at", null).order("created_at", { ascending: false }),
    supabase.from("scenarios").select("id, name").eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
  ]);
  const accountNames = new Map((accounts ?? []).map(account => [account.id, account.name]));
  const scenarioId = scenarios?.some(item => item.id === params.scenario) ? params.scenario : undefined;
  const projection = await evaluatePlan(horizon, scenarioId);
  const today = calendarDate(new Date(), workspace.timezone);
  const currency = workspace.display_currency;

  return <main className="mx-auto max-w-7xl space-y-7 px-4 py-8 text-foreground sm:px-6 lg:px-10">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-brand">Financial planning</p><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Financial horizon &amp; runway</h1><p className="mt-2 text-sm text-muted-foreground">Explore your forecast, cash reservations, and changes to your plan.</p></div>
      <div className="flex flex-wrap gap-2"><Link href="/plan/spending" className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted">Spending plans <ArrowRight className="ml-1 inline size-4" /></Link><Link href="/plan/currency" className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted">Currency <ArrowRight className="ml-1 inline size-4" /></Link></div>
    </header>
    <section className={card}>
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Projection</p><h2 className="mt-1 text-lg font-semibold">Liquid balance horizon</h2></div>
        <form method="get" className="flex flex-wrap items-end gap-2"><label className="grid gap-1 text-xs font-medium text-muted-foreground">Horizon in days <input name="horizon" type="number" min="1" max="365" defaultValue={horizon} className={field + " w-24 font-mono"} /></label>{scenarioId && <input type="hidden" name="scenario" value={scenarioId} />}<button className={button}><CalendarDays className="size-4" />Update</button></form></div>
      {projection.available.status === "available" ? <div className="mt-6"><p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Available to spend</p><p className="mt-1 font-mono text-3xl font-semibold tracking-tight">{formatMoney(projection.available.amountMinor, currency)}</p><p className="mt-1 text-xs text-muted-foreground">Conservative daily minimum on {projection.available.limitingDate}; includes confirmed assumptions and goal reservations.</p></div> : <div className="mt-6 rounded-lg bg-muted p-4 text-sm text-muted-foreground">Forecast unavailable: {projection.available.missingInputs.join(", ")}. Add dated balances and complete missing assumptions.</div>}
      {projection.forecast.status === "available" && <><ForecastChart days={projection.forecast.days} /><div className="mt-4 grid gap-3 sm:grid-cols-3">{([ ["Expected", projection.forecast.days.at(-1)!.expectedMinor], ["Conservative", projection.forecast.days.at(-1)!.conservativeMinor], ["Optimistic", projection.forecast.days.at(-1)!.optimisticMinor] ] as const).map(([label, amount]) => <div key={label} className="rounded-lg bg-muted/60 px-4 py-3"><p className="text-xs text-muted-foreground">{label} at horizon</p><p className="mt-1 font-mono text-base font-semibold">{formatMoney(amount, currency)}</p></div>)}</div></>}
    </section>
    <section className={card}><div className="flex items-center justify-between"><div><p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Reservations</p><h2 className="mt-1 text-lg font-semibold">Goals</h2></div></div><p className="text-sm text-muted-foreground">A goal does not reserve money until you allocate cash to it.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">{goals?.map(goal => {
        const earmarks = (allocations ?? []).filter(item => item.goal_id === goal.id);
        const comparable = earmarks.every(item => accounts?.find(account => account.id === item.account_id)?.currency_code === goal.currency_code);
        const reserved = earmarks.reduce((sum, item) => sum + BigInt(item.amount_minor), 0n);
        const plan = goalContributionProjection({ targetMinor: BigInt(goal.target_minor), savedMinor: goal.recorded_saved_minor === null ? null : BigInt(goal.recorded_saved_minor), monthlyMinor: BigInt(goal.planned_monthly_minor), startsOn: goal.contribution_starts_on }, today);
        return <article key={goal.id} className="rounded-lg border border-border bg-muted/35 p-4"><h3 className="font-medium">{goal.name}</h3><p>{formatMoney(goal.target_minor, goal.currency_code)} target {goal.target_date ? `by ${goal.target_date}` : ""}</p>
          <p className="mt-2 text-sm">Recorded savings: {goal.recorded_saved_minor === null ? "Unknown" : `${formatMoney(goal.recorded_saved_minor, goal.currency_code)} as of ${goal.saved_as_of} (manual evidence)`}</p>
          <p className="text-sm text-muted-foreground">Virtual cash reservations: {comparable ? formatMoney(reserved, goal.currency_code) : "Currency evidence required"}. Separate from recorded savings.</p>
          <p className="mt-2 text-sm text-muted-foreground">Priority {goal.priority} ? {goal.status} ? Planned {formatMoney(goal.planned_monthly_minor, goal.currency_code)} monthly{goal.contribution_starts_on ? ` from ${goal.contribution_starts_on}` : ""}.</p>
          <p className="text-sm text-muted-foreground">{plan.completionDate ? `Expected completion ${plan.completionDate}, assuming each planned contribution occurs.${goal.target_date && plan.completionDate > goal.target_date ? " After your target date." : ""}` : "Completion unavailable without dated savings and a contribution plan."} No future money is moved or reserved.</p>
          <details className="mt-3"><summary className="cursor-pointer text-sm underline">Reserve or release cash</summary><p className="mt-2 text-xs text-muted-foreground">Current verified liquid cash only, after pending holds and other goals. Set zero to release. Each account is checked separately; no money moves.</p>{(accounts ?? []).filter(account => earmarks.some(item => item.account_id === account.id) || (goal.status === "active" && account.currency_code === goal.currency_code && ["checking", "savings", "cash", "wallet"].includes(account.type))).map(account => { const existing = earmarks.find(item => item.account_id === account.id); return <form key={account.id} action={setAllocation} className="mt-3 flex flex-wrap items-end gap-2"><input type="hidden" name="goalId" value={goal.id} /><input type="hidden" name="accountId" value={account.id} /><input type="hidden" name="version" value={existing?.version ?? 0} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><label className="grid gap-1 text-xs">{account.name} reservation ({goal.currency_code})<input name="amount" inputMode="decimal" defaultValue={formatInputAmount(existing?.amount_minor ?? "0", goal.currency_code)} required className={field + " w-40"} /></label><button className="text-sm font-medium text-brand underline">Set reservation</button></form>; })}</details>
          <GoalPlanEditor goal={goal} today={today} />
        </article>;
      })}</div>
      <p className="mt-4 text-sm text-muted-foreground">Contribution plans in {currency} total {formatMoney((goals ?? []).filter(goal => goal.status === "active" && goal.currency_code === currency).reduce((sum, goal) => sum + BigInt(goal.planned_monthly_minor), 0n), currency)} per month. {projection.available.status === "available" ? "Compare this combined commitment with the conservative available funds above; repeated affordability depends on future obligations and income." : "Affordability is unavailable until the forecast has complete inputs."} Other currencies need dated conversion evidence.</p>
      <form action={createGoal} className="mt-5 flex flex-wrap items-end gap-2 rounded-lg bg-muted/50 p-4"><input type="hidden" name="requestId" value={crypto.randomUUID()} /><input name="name" required maxLength={120} placeholder="Goal name" className={field} /><input name="target" required placeholder="Target amount" className={field} /><input name="currency" defaultValue={currency} required maxLength={3} aria-label="Currency code" className={field + " w-20"} /><input name="targetDate" type="date" aria-label="Target date" className={field} /><button className={button}>Add goal</button></form>
    </section>
    <GoalPlanHistory />
    <ReservationHistory />
    <section className={card}><p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">What if</p><h2 className="mt-1 text-lg font-semibold">Scenario sandbox</h2><div className="mt-4 flex flex-wrap gap-2 border-b border-border pb-4"><Link href="/plan" className={!scenarioId ? "rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" : "rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium"}>Real plan</Link>{scenarios?.map(item => <Link key={item.id} href={`/plan?scenario=${item.id}`} className={item.id === scenarioId ? "rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" : "rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium"}>{item.name}</Link>)}</div>
      <form action={createScenario} className="mt-4 flex flex-wrap gap-2 rounded-lg bg-muted/50 p-4"><input name="name" required placeholder="What if…" className={field} /><button className={button}>Create scenario</button></form>
      {scenarioId && <form action={addScenarioEvent} className="mt-4 flex flex-wrap gap-2 rounded-lg bg-muted/50 p-4"><input type="hidden" name="scenarioId" value={scenarioId} /><input name="name" required placeholder="Laptop, raise…" className={field} /><input name="amount" required placeholder="-1200.00" className={field} /><select name="accountId" aria-label="Account" className={field}>{accounts?.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select><select name="cadence" aria-label="Cadence" className={field}><option value="once">Once</option><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="yearly">Yearly</option></select><input type="date" name="startsOn" defaultValue={today} required aria-label="Start date" className={field} /><button className={button}>Add hypothetical change</button></form>}
    </section>
    <section className={card}><p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Inputs</p><h2 className="mt-1 text-lg font-semibold">Financial model</h2><p className="text-sm text-muted-foreground">Confirmed income and expenses shape the forecast. Positive amounts add cash; negative amounts spend it. Your edits are marked user-confirmed and take priority over later inferred recurring updates.</p>
      {assumptionsError && <p role="alert" className="mt-4">Could not load assumptions: {assumptionsError.message}</p>}
      {!assumptionsError && !(assumptions ?? []).length && <p className="mt-4 text-muted-foreground">No assumptions yet. Add one below or confirm a pattern in Money → Recurring.</p>}
      <ul className="mt-4 space-y-3">{(assumptions ?? []).map(item => <li key={item.id} className="rounded-lg border border-border bg-muted/35 p-4 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium">{item.name}{item.enabled ? "" : " (disabled)"}</h3><p>Current value: {formatMoney(item.amount_minor, item.currency_code)}</p></div>
        <p className="mt-1 text-muted-foreground">{item.cadence} from {item.starts_on}{item.ends_on ? ` until ${item.ends_on}` : ""}{item.account_id ? ` · ${accountNames.get(item.account_id) ?? "Unknown account"}` : " · no account"}</p>
        <p className="mt-1 text-muted-foreground">Source: {item.source} · Confidence: {item.confidence ?? "n/a"}{item.confidence != null ? "%" : ""} · {item.confirmed ? "user-confirmed" : "estimated"}{item.source === "user" ? " · edited by you" : ""} · {item.enabled ? "active in forecast" : "excluded from forecast"}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={toggleAssumption}><input type="hidden" name="assumptionId" value={item.id} /><input type="hidden" name="version" value={item.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><input type="hidden" name="enabled" value={item.enabled ? "false" : "true"} /><button className="font-medium text-brand hover:underline">{item.enabled ? "Disable" : "Enable"}</button></form>
          <form action={deleteAssumption}><input type="hidden" name="assumptionId" value={item.id} /><input type="hidden" name="version" value={item.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><button className="font-medium text-brand hover:underline">Remove</button></form>
        </div>
        <details className="mt-3"><summary className="cursor-pointer underline">Edit</summary>
          <form action={updateAssumption} className="mt-3 flex flex-wrap gap-2"><input type="hidden" name="assumptionId" value={item.id} />
            <input type="hidden" name="version" value={item.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} />
            <input name="name" required maxLength={120} defaultValue={item.name} aria-label={`Edit ${item.name} name`} className={field} />
            <input name="amount" required defaultValue={formatInputAmount(item.amount_minor.toString(), item.currency_code)} aria-label={`Edit ${item.name} amount`} className={field + " w-28"} />
            <select name="cadence" defaultValue={item.cadence} aria-label={`Edit ${item.name} cadence`} className={field}><option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
            <input type="date" name="startsOn" required defaultValue={item.starts_on} aria-label={`Edit ${item.name} start date`} className={field} />
            <input type="date" name="endsOn" defaultValue={item.ends_on ?? ""} aria-label={`Edit ${item.name} end date`} className={field} />
            <button className="font-medium text-brand hover:underline">Save</button></form>
        </details>
      </li>)}</ul>
      {!accounts?.length && <p className="mt-4 text-muted-foreground">Add an account before creating a dated assumption.</p>}
      {!!accounts?.length && <form action={addAssumption} className="mt-5 flex flex-wrap items-end gap-2 rounded-lg bg-muted/50 p-4"><input name="name" required placeholder="Rent, salary…" maxLength={120} className={field} /><input name="amount" required placeholder="-1200.00" className={field} /><select name="accountId" aria-label="Account" className={field}>{accounts?.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select><select name="cadence" aria-label="Cadence" className={field}><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="daily">Daily</option><option value="yearly">Yearly</option><option value="once">Once</option></select><input type="date" name="startsOn" defaultValue={today} required aria-label="Start date" className={field} /><button className={button}>Add assumption</button></form>}
    </section>
    <PlanningHistory entityType="assumption" destination="/plan" />
  </main>;
}

async function ReservationHistory() {
  const { supabase, workspace } = await requireWorkspace();
  const [events, allocations, goals] = await Promise.all([
    supabase.from("goal_reservation_events").select("id, allocation_id, before, after, undo_of, undone_at, created_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(50),
    supabase.from("goal_allocations").select("id, version").eq("workspace_id", workspace.id),
    supabase.from("goals").select("id, name, currency_code").eq("workspace_id", workspace.id),
  ]);
  if (events.error || allocations.error || goals.error) throw events.error ?? allocations.error ?? goals.error;
  const versions = new Map((allocations.data ?? []).map(item => [item.id, item.version]));
  return <details className="rounded-xl border border-border bg-card p-5"><summary className="cursor-pointer font-semibold">Reservation history and undo</summary><p className="mt-2 text-xs text-muted-foreground">Latest 50 changes. Restore older reservations in reverse order; restoring funds requires current cash evidence.</p><ul className="mt-3 space-y-3">{(events.data ?? []).map(event => { const after = event.after as { amount_minor: string; goal_id: string }; const before = event.before as { amount_minor: string }; const goal = goals.data?.find(item => item.id === after.goal_id); if (!goal) throw new Error("Reservation goal evidence unavailable"); return <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><div><p>{goal.name}: {formatMoney(before.amount_minor, goal.currency_code)} ? {formatMoney(after.amount_minor, goal.currency_code)}</p><p className="text-xs text-muted-foreground">{new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })} ? {event.undo_of ? "Restoration" : event.undone_at ? "Undone" : "Reservation changed"}</p></div>{!event.undo_of && !event.undone_at && <form action={undoReservation}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={versions.get(event.allocation_id)} /><button className="text-brand underline">Undo reservation</button></form>}</li>; })}</ul>{!events.data?.length && <p className="mt-3 text-sm text-muted-foreground">No reservation changes recorded yet.</p>}</details>;
}
