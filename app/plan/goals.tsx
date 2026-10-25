import { SourceCoverageDetails } from "@/app/source-coverage";
import { buildSourceCoverage } from "@/lib/finance/source-coverage";
import { goalContributionProjection } from "@/lib/finance/goals";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { createGoal, setAllocation } from "./actions";
import { GoalPlanEditor, type Goal } from "./goal-plan";
import { button, card, eyebrow, field, linkButton, percentOf } from "./ui";

type Allocation = { id: string; goal_id: string; account_id: string; amount_minor: string; version: number };
type Account = { id: string; name: string; currency_code: string; type: string; archived_at: string | null };
const liquid = ["checking", "savings", "cash", "wallet"];

function GoalCard({ goal, allocations, accounts, locale, today }: { goal: Goal; allocations: Allocation[]; accounts: Account[]; locale?: string; today: string }) {
  const money = (amount: bigint | string) => formatMoney(amount, goal.currency_code, locale);
  const target = BigInt(goal.target_minor);
  const comparable = allocations.every(item => accounts.find(account => account.id === item.account_id)?.currency_code === goal.currency_code);
  const reserved = allocations.reduce((sum, item) => sum + BigInt(item.amount_minor), 0n);
  const saved = goal.recorded_saved_minor === null ? null : BigInt(goal.recorded_saved_minor);
  const monthly = BigInt(goal.planned_monthly_minor);
  const plan = goalContributionProjection({ targetMinor: target, savedMinor: saved, monthlyMinor: monthly, startsOn: goal.contribution_starts_on }, today);
  const late = !!(goal.target_date && plan.completionDate && plan.completionDate > goal.target_date);
  // The bar tracks recorded savings; reserved cash is a separate, virtual earmark.
  const progress = saved ?? (comparable ? reserved : null);
  const reservable = accounts.filter(account => allocations.some(item => item.account_id === account.id) || (goal.status === "active" && !account.archived_at && account.currency_code === goal.currency_code && liquid.includes(account.type)));
  return <article className="flex flex-col gap-3 rounded-lg border border-border bg-muted/35 p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium">{goal.name}</h3>
      <span className="text-xs text-muted-foreground">{goal.status === "active" ? `Priority ${goal.priority}` : goal.status.charAt(0).toUpperCase() + goal.status.slice(1)}</span></div>
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm"><span className="font-mono font-semibold">{progress === null ? "Saved unknown" : money(progress)}</span><span className="text-muted-foreground">of {money(target)}{goal.target_date ? ` by ${goal.target_date}` : ""}</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${goal.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress === null ? undefined : percentOf(progress, target)}>
        <div className="h-full rounded-full bg-brand" style={{ width: `${progress === null ? 0 : percentOf(progress, target)}%` }} /></div>
      <p className="mt-1 text-xs text-muted-foreground">{saved !== null ? `Saved so far as of ${goal.saved_as_of}` : comparable ? "Saved so far is unknown; bar shows reserved cash" : "Saved so far is unknown"}</p>
    </div>
    <dl className="grid grid-cols-2 gap-2 text-sm">
      <div className="rounded-md bg-card px-3 py-2"><dt className="text-xs text-muted-foreground">Monthly plan</dt><dd className="font-mono">{monthly > 0n ? money(monthly) : "None"}</dd>{goal.contribution_starts_on && monthly > 0n && <dd className="text-xs text-muted-foreground">from {goal.contribution_starts_on}</dd>}</div>
      <div className="rounded-md bg-card px-3 py-2"><dt className="text-xs text-muted-foreground">Cash set aside</dt><dd className="font-mono">{comparable ? money(reserved) : "Needs an exchange rate"}</dd></div>
    </dl>
    <p className={late ? "text-sm font-medium" : "text-sm text-muted-foreground"}>{plan.completionDate
      ? `Expected completion ${plan.completionDate}, if every planned contribution is made.${late ? " That is after your target date." : ""}`
      : "Completion date unavailable without dated savings and a monthly plan."}</p>
    <SourceCoverageDetails coverage={buildSourceCoverage({ from: goal.saved_as_of && goal.saved_as_of <= today ? goal.saved_as_of : today, to: today, currencyCode: goal.currency_code, recordBasis: "manual_goals" }, [])} />
    <details><summary className="cursor-pointer text-sm underline">Reserve or release cash</summary><p className="mt-2 text-sm text-muted-foreground">Set an amount to reserve it, or zero to release it. No money moves.</p>
      {reservable.map(account => { const existing = allocations.find(item => item.account_id === account.id); return <form key={account.id} action={setAllocation} className="mt-3 flex flex-wrap items-end gap-2"><input type="hidden" name="goalId" value={goal.id} /><input type="hidden" name="accountId" value={account.id} /><input type="hidden" name="version" value={existing?.version ?? 0} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><label className="grid gap-1 text-xs">{account.name} reservation ({goal.currency_code})<input name="amount" inputMode="decimal" defaultValue={formatInputAmount(existing?.amount_minor ?? "0", goal.currency_code)} required className={field + " w-40"} /></label><button className={linkButton}>Set reservation</button></form>; })}
      {!reservable.length && <p className="mt-2 text-sm text-muted-foreground">No active {goal.currency_code} cash account to reserve from.</p>}
    </details>
    <GoalPlanEditor goal={goal} today={today} />
  </article>;
}

export function GoalsSection({ goals, allocations, accounts, currency, locale, today }: { goals: Goal[]; allocations: Allocation[]; accounts: Account[]; currency: string; locale?: string; today: string }) {
  const monthly = goals.filter(goal => goal.status === "active" && goal.currency_code === currency).reduce((sum, goal) => sum + BigInt(goal.planned_monthly_minor), 0n);
  return <section className={card} aria-labelledby="goals-heading">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className={eyebrow}>Reservations</p><h2 id="goals-heading" className="mt-1 text-sm font-medium">Goals</h2></div>
      <p className="text-sm text-muted-foreground">Planned {formatMoney(monthly, currency, locale)} monthly in {currency}</p></div>
    <p className="text-sm text-muted-foreground">A goal only sets money aside once you reserve cash for it.</p>
    {goals.length ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{goals.map(goal => <GoalCard key={goal.id} goal={goal} allocations={allocations.filter(item => item.goal_id === goal.id)} accounts={accounts} locale={locale} today={today} />)}</div>
      : <p className="text-sm text-muted-foreground">No goals yet. Add one below.</p>}
    <form action={createGoal} className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/50 p-4"><input type="hidden" name="requestId" value={crypto.randomUUID()} /><input name="name" required maxLength={120} placeholder="Goal name" aria-label="Goal name" className={field} /><input name="target" required inputMode="decimal" placeholder="Target amount" aria-label="Target amount" className={field} /><input name="currency" defaultValue={currency} required maxLength={3} aria-label="Currency code" className={field + " w-20"} /><input name="targetDate" type="date" aria-label="Target date" className={field} /><button className={button}>Add goal</button></form>
  </section>;
}
