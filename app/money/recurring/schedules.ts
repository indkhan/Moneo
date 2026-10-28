import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recurringCadences } from "@/lib/finance/cadences";
import { payloadSchemas } from "@/lib/ai/agent-team";

// Every way to add, change, confirm or remove a recurring schedule, shared by the Recurring page and chat cards.
// Writes go through the same audited paths as Plan: an insert for new schedules, edit_assumption (undoable) for changes.
type Context = { supabase: SupabaseClient; workspace: { id: string } };

export const scheduleFields = z.object({
  name: z.string().trim().min(1).max(120),
  amountMinor: z.string().regex(/^-?[1-9]\d{0,17}$/, "Amount cannot be zero"),
  cadence: z.enum(recurringCadences),
  startsOn: z.iso.date(),
  category: z.string().trim().max(100).nullable(),
}).strict();
export type ScheduleFields = z.infer<typeof scheduleFields>;
export const seriesSchema = payloadSchemas.recurring;
export type SeriesDecision = z.infer<typeof seriesSchema>;

/** The category with this name, created when missing; blank means no category. */
async function categoryId({ supabase, workspace }: Context, name: string | null | undefined) {
  if (!name) return null;
  const { data, error } = await supabase.from("categories").upsert({ workspace_id: workspace.id, name }, { onConflict: "workspace_id,name" }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

export async function createSchedule(context: Context, accountId: string, fields: ScheduleFields) {
  const { supabase, workspace } = context;
  const { data: account, error: accountError } = await supabase.from("accounts").select("currency_code").eq("workspace_id", workspace.id).eq("id", accountId).is("archived_at", null).maybeSingle();
  if (accountError || !account) throw new Error("Account not found");
  const { data, error } = await supabase.from("financial_assumptions").insert({
    workspace_id: workspace.id, account_id: accountId, name: fields.name, kind: BigInt(fields.amountMinor) > 0n ? "income" : "expense",
    amount_minor: fields.amountMinor, currency_code: account.currency_code, cadence: fields.cadence, starts_on: fields.startsOn,
    category_id: await categoryId(context, fields.category), source: "user", confirmed: true, enabled: true,
  }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

/** Applies only the fields that differ, so an unchanged schedule keeps its detected calendar and evidence. */
export async function editSchedule(context: Context, id: string, changes: Partial<ScheduleFields>, requestId: string) {
  const { supabase, workspace } = context;
  const { data: current, error: lookupError } = await supabase.from("financial_assumptions")
    .select("version, name, amount_minor::text, cadence, starts_on, category:categories(name)").eq("workspace_id", workspace.id).eq("id", id).is("removed_at", null).maybeSingle();
  if (lookupError || !current) throw new Error("This recurring payment was removed or is unavailable");
  const currentCategory = (Array.isArray(current.category) ? current.category[0] : current.category)?.name ?? null;
  const patch: Record<string, unknown> = {};
  if (changes.name !== undefined && changes.name !== current.name) patch.name = changes.name;
  if (changes.amountMinor !== undefined && changes.amountMinor !== current.amount_minor) {
    patch.amount_minor = changes.amountMinor; patch.kind = BigInt(changes.amountMinor) > 0n ? "income" : "expense";
  }
  if (changes.cadence !== undefined && changes.cadence !== current.cadence) patch.cadence = changes.cadence;
  if (changes.startsOn !== undefined && changes.startsOn !== current.starts_on) patch.starts_on = changes.startsOn;
  if (changes.category !== undefined && (changes.category || null) !== currentCategory) patch.category_id = await categoryId(context, changes.category);
  if (!Object.keys(patch).length) return;
  const { error } = await supabase.rpc("edit_assumption", { p_id: id, p_expected_version: current.version, p_patch: patch, p_request_id: requestId });
  if (error) throw new Error(error.message);
}

export async function removeSchedule({ supabase, workspace }: Context, id: string, requestId: string) {
  const { data: current } = await supabase.from("financial_assumptions").select("version").eq("workspace_id", workspace.id).eq("id", id).is("removed_at", null).maybeSingle();
  if (!current) throw new Error("This recurring payment was already removed");
  const { error } = await supabase.rpc("edit_assumption", { p_id: id, p_expected_version: current.version, p_patch: { removed: true }, p_request_id: requestId });
  if (error) throw new Error(error.message);
}

/** Confirms a detected pattern with its evidence, then applies any changes the person made before confirming. */
export async function decideSeries(context: Context, series: SeriesDecision, decision: "confirmed" | "dismissed", changes: Partial<ScheduleFields> = {}, requestId = crypto.randomUUID()) {
  const { data, error } = await context.supabase.rpc("review_recurring_series_versions", {
    p_decision: decision, p_account_id: series.accountId, p_label: series.label, p_cadence: series.cadence, p_currency_code: series.currencyCode,
    p_evidence: series.evidence, p_run_anchor_id: series.runAnchorId, p_evidence_limited: series.evidenceLimited,
  });
  if (error) throw new Error(error.message);
  const assumptionId = (data as { assumption_id: string | null } | null)?.assumption_id;
  if (decision === "confirmed" && assumptionId) await editSchedule(context, assumptionId, changes, requestId);
  return assumptionId ?? null;
}
