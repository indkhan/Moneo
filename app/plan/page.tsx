import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { evaluatePlan } from "@/lib/finance/model";
import { addAssumption, addScenarioEvent, createGoal, createScenario, setAllocation } from "./actions";

function money(minor: string | bigint, currency: string) {
  const value = BigInt(minor);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${currency} ${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ horizon?: string; scenario?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const params = await searchParams;
  const horizon = Math.min(365, Math.max(1, Number(params.horizon) || 30));
  const [{ data: goals }, { data: allocations }, { data: accounts }, { data: assumptions }, { data: scenarios }] = await Promise.all([
    supabase.from("goals").select("id, name, target_minor, currency_code, target_date, priority, status, notes")
      .eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
    supabase.from("goal_allocations").select("goal_id, account_id, amount_minor").eq("workspace_id", workspace.id),
    supabase.from("accounts").select("id, name, currency_code, type").eq("workspace_id", workspace.id).order("name"),
    supabase.from("financial_assumptions").select("id, name, amount_minor, currency_code, cadence, starts_on, source, confidence, confirmed, enabled")
      .eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
    supabase.from("scenarios").select("id, name").eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
  ]);
  const scenarioId = scenarios?.some(item => item.id === params.scenario) ? params.scenario : undefined;
  const projection = await evaluatePlan(horizon, scenarioId);
  const today = new Date().toISOString().slice(0, 10);
  const currency = workspace.display_currency;

  return <main className="mx-auto max-w-5xl space-y-10 px-6 py-10">
    <header><Link href="/" className="text-sm text-muted-foreground">← Home</Link><h1 className="mt-2 text-3xl font-semibold">Plan</h1></header>
    <section className="rounded-lg border p-5"><h2 className="text-xl font-semibold">Available to spend</h2>
      <form method="get" className="mt-3 flex items-center gap-3"><label>Horizon (days) <input name="horizon" type="number" min="1" max="365" defaultValue={horizon} className="ml-2 w-20 rounded border p-1" /></label>{scenarioId && <input type="hidden" name="scenario" value={scenarioId} />}<button className="underline">Update</button></form>
      {projection.available.status === "available" ? <><p className="mt-4 text-3xl font-semibold">{money(projection.available.amountMinor, currency)}</p><p className="text-sm text-muted-foreground">Conservative daily minimum on {projection.available.limitingDate}. Includes confirmed and enabled assumptions and goal reservations.</p></> : <p className="mt-4 text-muted-foreground">Unavailable: {projection.available.missingInputs.join(", ")}. Add dated account balances and complete missing assumptions.</p>}
      {projection.forecast.status === "available" && <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3"><p>Expected at horizon: {money(projection.forecast.days.at(-1)!.expectedMinor, currency)}</p><p>Conservative: {money(projection.forecast.days.at(-1)!.conservativeMinor, currency)}</p><p>Optimistic: {money(projection.forecast.days.at(-1)!.optimisticMinor, currency)}</p></div>}
    </section>
    <section><h2 className="text-xl font-semibold">Goals</h2><p className="text-sm text-muted-foreground">A goal does not reserve money until you allocate cash to it.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">{goals?.map(goal => <article key={goal.id} className="rounded border p-4"><h3 className="font-medium">{goal.name}</h3><p>{money(goal.target_minor, goal.currency_code)} target {goal.target_date ? `by ${goal.target_date}` : ""}</p><p className="text-sm text-muted-foreground">Reserved: {money((allocations ?? []).filter(item => item.goal_id === goal.id).reduce((sum, item) => sum + BigInt(item.amount_minor), 0n), goal.currency_code)}</p>
        {!!accounts?.length && <form action={setAllocation} className="mt-3 flex flex-wrap gap-2"><input type="hidden" name="goalId" value={goal.id} /><select name="accountId" aria-label="Account" className="rounded border p-2">{accounts.filter(account => account.currency_code === goal.currency_code).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select><input name="amount" aria-label="Reserve amount" placeholder="0.00" required className="w-28 rounded border p-2" /><button className="underline">Set reservation</button></form>}
      </article>)}</div>
      <form action={createGoal} className="mt-5 flex flex-wrap gap-2"><input type="hidden" name="requestId" value={crypto.randomUUID()} /><input name="name" required maxLength={120} placeholder="Goal name" className="rounded border p-2" /><input name="target" required placeholder="Target amount" className="rounded border p-2" /><input name="currency" defaultValue={currency} required maxLength={3} aria-label="Currency code" className="w-20 rounded border p-2" /><input name="targetDate" type="date" aria-label="Target date" className="rounded border p-2" /><button className="rounded bg-primary px-4 text-primary-foreground">Add goal</button></form>
    </section>
    <section><h2 className="text-xl font-semibold">Financial model</h2><p className="text-sm text-muted-foreground">Confirmed income and expenses shape the forecast. Positive amounts add cash; negative amounts spend it.</p>
      <ul className="mt-4 space-y-2">{assumptions?.map(item => <li key={item.id} className="rounded border p-3 text-sm">{item.name}: {money(item.amount_minor, item.currency_code)} {item.cadence} from {item.starts_on} · {item.source} {item.confirmed ? "· confirmed" : "· estimated"}</li>)}</ul>
      <form action={addAssumption} className="mt-5 flex flex-wrap gap-2"><input name="name" required placeholder="Rent, salary…" className="rounded border p-2" /><input name="amount" required placeholder="-1200.00" className="rounded border p-2" /><select name="accountId" aria-label="Account" className="rounded border p-2">{accounts?.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select><select name="cadence" aria-label="Cadence" className="rounded border p-2"><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="daily">Daily</option><option value="once">Once</option></select><input type="date" name="startsOn" defaultValue={today} required aria-label="Start date" className="rounded border p-2" /><button className="rounded bg-primary px-4 text-primary-foreground">Add assumption</button></form>
    </section>
    <section><h2 className="text-xl font-semibold">Scenarios</h2><div className="mt-3 flex flex-wrap gap-3"><Link href="/plan" className={!scenarioId ? "font-semibold underline" : "underline"}>Real plan</Link>{scenarios?.map(item => <Link key={item.id} href={`/plan?scenario=${item.id}`} className={item.id === scenarioId ? "font-semibold underline" : "underline"}>{item.name}</Link>)}</div>
      <form action={createScenario} className="mt-4 flex gap-2"><input name="name" required placeholder="What if…" className="rounded border p-2" /><button className="rounded bg-primary px-4 text-primary-foreground">Create scenario</button></form>
      {scenarioId && <form action={addScenarioEvent} className="mt-4 flex flex-wrap gap-2"><input type="hidden" name="scenarioId" value={scenarioId} /><input name="name" required placeholder="Laptop, raise…" className="rounded border p-2" /><input name="amount" required placeholder="-1200.00" className="rounded border p-2" /><select name="accountId" aria-label="Account" className="rounded border p-2">{accounts?.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select><select name="cadence" aria-label="Cadence" className="rounded border p-2"><option value="once">Once</option><option value="monthly">Monthly</option><option value="weekly">Weekly</option></select><input type="date" name="startsOn" defaultValue={today} required aria-label="Start date" className="rounded border p-2" /><button className="rounded bg-primary px-4 text-primary-foreground">Add hypothetical change</button></form>}
    </section>
  </main>;
}
