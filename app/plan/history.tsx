import { requireWorkspace } from "@/lib/auth";
import { formatMoney } from "@/lib/finance/format";
import { undoPlanningEvent } from "./actions";

export async function PlanningHistory({ entityType, destination }: { entityType: "assumption" | "spending_plan"; destination: "/plan" | "/plan/spending" }) {
  const { supabase, workspace } = await requireWorkspace();
  const { data: events, error } = await supabase.from("planning_events")
    .select("id, entity_id, before, after, created_at, undone, undone_at")
    .eq("workspace_id", workspace.id).eq("entity_type", entityType)
    .order("created_at", { ascending: false }).order("id").limit(50);
  if (error) throw error;
  const { data: records, error: recordError } = await supabase.from(entityType === "assumption" ? "financial_assumptions" : "spending_plans")
    .select("id, version").eq("workspace_id", workspace.id).in("id", [...new Set((events ?? []).map(event => event.entity_id))]);
  if (recordError) throw recordError;
  const versions = new Map((records ?? []).map(row => [row.id, row.version]));
  return <details className="rounded-xl border border-border bg-card p-5 shadow-sm">
    <summary className="cursor-pointer font-semibold">{entityType === "assumption" ? "Financial model" : "Spending plan"} history and undo</summary>
    <p className="mt-2 text-sm text-muted-foreground">Latest 50 changes. Undo restores the previous values when the record still matches this change. Undo newer edits first; later inference or conflicting edits require review.</p>
    <ul className="mt-3 space-y-3">{(events ?? []).map(event => {
      const after = event.after as Record<string, string | boolean | null> | null;
      const before = event.before as Record<string, string | boolean | null> | null;
      const value = after ?? before;
      const amount = value?.[entityType === "assumption" ? "amount_minor" : "limit_minor"];
      const version = versions.get(event.entity_id);
      return <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
        <div><p className="font-medium">{String(value?.name ?? "Spending plan")} · {after?.removed_at ? "Removed" : !before ? "Created" : "Changed"}</p>
          <p className="text-muted-foreground">{typeof amount === "string" && typeof value?.currency_code === "string" ? `${formatMoney(amount, value.currency_code)} · ` : ""}{new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{event.undone ? " · Undone" : ""}</p></div>
        {!event.undone && version !== undefined && <form action={undoPlanningEvent}>
          <input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={version} /><input type="hidden" name="destination" value={destination} />
          <button className="font-medium text-brand hover:underline">Undo</button>
        </form>}
      </li>;
    })}</ul>
    {!events?.length && <p className="mt-3 text-sm text-muted-foreground">No planning changes recorded yet.</p>}
  </details>;
}
