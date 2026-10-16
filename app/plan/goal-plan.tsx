import { requireWorkspace } from "@/lib/auth";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { updateGoalPlan, undoGoalPlan, undoReservation } from "./actions";
import { button, stackedField as field } from "./ui";

export type Goal = { id: string; version: number; name: string; target_minor: string; currency_code: string; target_date: string | null; priority: number; status: string; notes: string | null; planned_monthly_minor: string; contribution_starts_on: string | null; recorded_saved_minor: string | null; saved_as_of: string | null };

export function GoalPlanEditor({ goal, today }: { goal: Goal; today: string }) {
  return <details><summary className="cursor-pointer text-sm underline">Edit goal and contribution plan</summary>
    <form action={updateGoalPlan} className="mt-3 grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="goalId" value={goal.id} /><input type="hidden" name="version" value={goal.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} />
      <label className="text-sm font-medium">Name<input name="name" required maxLength={120} defaultValue={goal.name} className={field} /></label>
      <label className="text-sm font-medium">Target ({goal.currency_code})<input name="target" required inputMode="decimal" defaultValue={formatInputAmount(goal.target_minor, goal.currency_code)} className={field} /></label>
      <label className="text-sm font-medium">Target date<input name="targetDate" type="date" defaultValue={goal.target_date ?? ""} className={field} /></label>
      <label className="text-sm font-medium">Priority (0 is first)<input name="priority" type="number" min={0} max={100} required defaultValue={goal.priority} className={field} /></label>
      <label className="text-sm font-medium">Status<select name="status" defaultValue={goal.status} className={field}><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option><option value="archived">Archived</option></select></label>
      <label className="text-sm font-medium">Planned monthly contribution ({goal.currency_code})<input name="monthly" required inputMode="decimal" defaultValue={formatInputAmount(goal.planned_monthly_minor, goal.currency_code)} className={field} /></label>
      <label className="text-sm font-medium">First contribution date<input name="startsOn" type="date" defaultValue={goal.contribution_starts_on ?? ""} className={field} /></label>
      <label className="text-sm font-medium">Saved so far ({goal.currency_code})<input name="saved" inputMode="decimal" defaultValue={goal.recorded_saved_minor === null ? "" : formatInputAmount(goal.recorded_saved_minor, goal.currency_code)} placeholder="Unknown" className={field} /></label>
      <label className="text-sm font-medium">Savings as of<input name="savedAsOf" type="date" max={today} defaultValue={goal.saved_as_of ?? ""} className={field} /></label>
      <label className="text-sm font-medium">Notes<textarea name="notes" maxLength={1000} defaultValue={goal.notes ?? ""} className={field} /></label>
      <div className="space-y-3 sm:col-span-2"><p className="text-sm text-muted-foreground">Saving this form does not move any money.</p>
      <button className={button}>Save goal plan</button></div>
    </form>
  </details>;
}

const when = (value: string, workspace: { locale: string; timezone: string }) => new Date(value).toLocaleString(workspace.locale, { timeZone: workspace.timezone });

// Goals come from the page's own query, so history only loads its events.
export async function GoalPlanHistory({ goals }: { goals: Pick<Goal, "id" | "version">[] }) {
  const { supabase, workspace } = await requireWorkspace();
  const { data: events, error } = await supabase.from("goal_events").select("id, goal_id, before, after, created_at, undone").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  const versions = new Map(goals.map(goal => [goal.id, goal.version]));
  return <details className="rounded-xl border border-border bg-card p-5"><summary className="cursor-pointer font-semibold">Goal history and undo</summary><p className="mt-2 text-sm text-muted-foreground">Latest 50 changes. Undo the newest first. Undoing a new goal archives it; release its reserved cash separately.</p>
    <ul className="mt-4 space-y-3">{(events ?? []).map(event => { const after = event.after as Goal; return <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><div><p>{after.name} · {formatMoney(after.target_minor, after.currency_code, workspace.locale)} target</p><p className="text-muted-foreground">{when(event.created_at, workspace)} · {event.undone ? "Undone" : event.before ? "Changed" : "Created"}</p></div>{!event.undone && <form action={undoGoalPlan}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={versions.get(event.goal_id)} /><button className="text-brand underline">Undo goal change</button></form>}</li>; })}</ul>{!events?.length && <p className="mt-3 text-sm text-muted-foreground">No goal changes recorded yet.</p>}
  </details>;
}

export async function ReservationHistory({ goals, allocations }: { goals: Pick<Goal, "id" | "name" | "currency_code">[]; allocations: { id: string; version: number }[] }) {
  const { supabase, workspace } = await requireWorkspace();
  const { data: events, error } = await supabase.from("goal_reservation_events").select("id, allocation_id, before, after, undo_of, undone_at, created_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  const versions = new Map(allocations.map(item => [item.id, item.version]));
  const byId = new Map(goals.map(goal => [goal.id, goal]));
  return <details className="rounded-xl border border-border bg-card p-5"><summary className="cursor-pointer font-semibold">Reservation history and undo</summary><p className="mt-2 text-sm text-muted-foreground">Latest 50 changes. Undo the newest first.</p><ul className="mt-4 space-y-3">{(events ?? []).map(event => {
    const after = event.after as { amount_minor: string; goal_id: string }; const before = event.before as { amount_minor: string };
    const goal = byId.get(after.goal_id);
    if (!goal) throw new Error("Reservation goal evidence unavailable");
    return <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><div><p>{goal.name}: {formatMoney(before.amount_minor, goal.currency_code, workspace.locale)} → {formatMoney(after.amount_minor, goal.currency_code, workspace.locale)}</p><p className="text-muted-foreground">{when(event.created_at, workspace)} · {event.undo_of ? "Restoration" : event.undone_at ? "Undone" : "Reservation changed"}</p></div>{!event.undo_of && !event.undone_at && <form action={undoReservation}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={versions.get(event.allocation_id)} /><button className="text-brand underline">Undo reservation</button></form>}</li>;
  })}</ul>{!events?.length && <p className="mt-3 text-sm text-muted-foreground">No reservation changes recorded yet.</p>}</details>;
}
