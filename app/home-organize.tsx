import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { displayFormat } from "@/lib/display-format";
import { countNeedsYou } from "@/lib/organize/surfaces";
import { organizeRunState } from "@/lib/organize/status";

/** One line on Home about the organizer: rows waiting for you, and a held-back or running pass. Nothing when there is nothing to say. */
export async function HomeOrganize({ db, workspace }: { db: SupabaseClient; workspace: { id: string; locale: string; timezone: string } }) {
  const [needs, run] = await Promise.all([
    countNeedsYou(db, workspace.id).catch(() => ({ questions: 0, rows: 0 })),
    db.from("agent_runs").select("status, rerun_trigger, organize_after").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(1).maybeSingle()
      .then(result => result.data as { status: string; rerun_trigger: string | null; organize_after: string | null } | null, () => null),
  ]);
  const state = organizeRunState(run, new Date());
  if (!needs.rows && !state.working && !state.pausedUntil) return null;
  return <p role="status" aria-label="Organizer" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-ai-border bg-ai-soft px-4 py-3 text-sm">
    {needs.rows > 0 && <Link href="/money/organize" className="font-medium underline-offset-2 hover:underline">{needs.rows} {needs.rows === 1 ? "row needs" : "rows need"} you</Link>}
    {state.working && <span className="text-muted-foreground">Organizing your latest rows now{state.queued ? "; another pass is queued" : ""}.</span>}
    {state.pausedUntil && <span className="text-muted-foreground">Organizing is paused until {displayFormat(workspace.locale, workspace.timezone).dateTime(state.pausedUntil)}: the AI plan limit was reached, and rows left blank are retried then.</span>}
  </p>;
}
