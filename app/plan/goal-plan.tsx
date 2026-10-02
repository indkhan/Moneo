import { requireWorkspace } from "@/lib/auth";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { updateGoalPlan, undoGoalPlan } from "./actions";

type Goal = { id: string; version: number; name: string; target_minor: string; currency_code: string; target_date: string | null; priority: number; status: string; notes: string | null; planned_monthly_minor: string; contribution_starts_on: string | null; recorded_saved_minor: string | null; saved_as_of: string | null };
const field = "mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm";

export function GoalPlanEditor({ goal, today }: { goal: Goal; today: string }) {
  return <details className="mt-4"><summary className="cursor-pointer text-sm underline">Edit goal and contribution plan</summary>
    <form action={updateGoalPlan} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="goalId" value={goal.id} /><input type="hidden" name="version" value={goal.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} />
      <label className="text-sm">Name<input name="name" required maxLength={120} defaultValue={goal.name} className={field} /></label>
      <label className="text-sm">Target ({goal.currency_code})<input name="target" required inputMode="decimal" defaultValue={formatInputAmount(goal.target_minor, goal.currency_code)} className={field} /></label>
      <label className="text-sm">Target date<input name="targetDate" type="date" defaultValue={goal.target_date ?? ""} className={field} /></label>
      <label className="text-sm">Priority (0 is first)<input name="priority" type="number" min={0} max={100} required defaultValue={goal.priority} className={field} /></label>
      <label className="text-sm">Status<select name="status" defaultValue={goal.status} className={field}><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option><option value="archived">Archived</option></select></label>
      <label className="text-sm">Planned monthly contribution ({goal.currency_code})<input name="monthly" required inputMode="decimal" defaultValue={formatInputAmount(goal.planned_monthly_minor, goal.currency_code)} className={field} /></label>
      <label className="text-sm">First contribution date<input name="startsOn" type="date" defaultValue={goal.contribution_starts_on ?? ""} className={field} /></label>
      <label className="text-sm">Recorded actual savings ({goal.currency_code})<input name="saved" inputMode="decimal" defaultValue={goal.recorded_saved_minor === null ? "" : formatInputAmount(goal.recorded_saved_minor, goal.currency_code)} placeholder="Unknown" className={field} /></label>
      <label className="text-sm">Savings evidence date<input name="savedAsOf" type="date" max={today} defaultValue={goal.saved_as_of ?? ""} className={field} /></label>
      <label className="text-sm">Notes<textarea name="notes" maxLength={1000} defaultValue={goal.notes ?? ""} className={field} /></label>
      <p className="text-xs text-muted-foreground sm:col-span-2">Recorded savings are your dated statement of progress. Reservations are cash earmarks and are shown separately. Contributions are future plans; saving this form does not move money or reserve future income.</p>
      <button className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Save goal plan</button>
    </form>
  </details>;
}

export async function GoalPlanHistory() {
  const { supabase, workspace } = await requireWorkspace();
  const [events, goals] = await Promise.all([
    supabase.from("goal_events").select("id, goal_id, before, after, created_at, undone").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(50),
    supabase.from("goals").select("id, version").eq("workspace_id", workspace.id),
  ]);
  if (events.error || goals.error) throw events.error ?? goals.error;
  const versions = new Map((goals.data ?? []).map(goal => [goal.id, goal.version]));
  return <details className="rounded-xl border border-border bg-card p-5"><summary className="cursor-pointer font-semibold">Goal history and undo</summary><p className="mt-2 text-xs text-muted-foreground">Latest 50 changes. Undo newer edits first. Undoing creation archives the goal and preserves reservations; release those separately.</p>
    <ul className="mt-3 space-y-3">{(events.data ?? []).map(event => { const after = event.after as Goal; return <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><div><p>{after.name} · {formatMoney(after.target_minor, after.currency_code, workspace.locale)} target</p><p className="text-xs text-muted-foreground">{new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })} · {event.undone ? "Undone" : event.before ? "Changed" : "Created"}</p></div>{!event.undone && <form action={undoGoalPlan}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={versions.get(event.goal_id)} /><button className="text-brand underline">Undo goal change</button></form>}</li>; })}</ul>{!events.data?.length && <p className="mt-3 text-sm text-muted-foreground">No goal changes recorded yet.</p>}
  </details>;
}
