import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";

export async function loadReviewGoals(input: unknown, db: SupabaseClient, workspaceId: string) {
  const args = z.object({goalIds: z.array(z.uuid()).min(1).max(20).optional(), limit: z.number().int().min(1).max(10)}).strict().parse(input);
  let query = db.from("goals").select("id, name, target_minor::text, currency_code, target_date, status, recorded_saved_minor::text, saved_as_of, planned_monthly_minor::text, contribution_starts_on")
    .eq("workspace_id", workspaceId).order("id").limit(args.limit + 1);
  if (args.goalIds) query = query.in("id", args.goalIds);
  const goals = await query;
  if (goals.error) throw goals.error;
  const selected = (goals.data ?? []).slice(0, args.limit);
  const undated = selected.filter(goal => goal.recorded_saved_minor !== null && !z.iso.date().safeParse(goal.saved_as_of).success);
  return {goals: selected.map(goal => undated.includes(goal) ? {...goal, recorded_saved_minor: null} : goal),
    ...(undated.length ? {missingInputs: undated.map(goal => `Goal ${goal.id}: recorded savings require an explicit valid as-of date; no current savings or remaining amount is inferred.`), calculationEvidence: {undatedManualRecords: undated}} : {}),
    ...(goals.data && goals.data.length > args.limit ? {limitation: "Goal support is bounded; additional selected goals remain unexplored."} : {}),
    ...(args.goalIds && args.goalIds.some(id => !goals.data?.some(goal => goal.id === id)) ? {limitation: "Some selected goals are unavailable or outside the supporting-record budget."} : {})};
}
