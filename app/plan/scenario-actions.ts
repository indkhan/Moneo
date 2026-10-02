"use server";
import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/auth";
import { parseManualAmount } from "@/app/money/transactions/input";

const version = z.coerce.number().int().min(1).max(2147483646);
async function edit(form: FormData, type: "scenario" | "override", patch: Record<string, unknown>) {
  const { supabase } = await requireWorkspace();
  const id = z.uuid().parse(form.get("recordId"));
  let scenarioId = id;
  if (type === "override") {
    const { data, error } = await supabase.from("scenario_overrides").select("scenario_id").eq("id", id).single();
    if (error || !data) throw new Error("Scenario event unavailable");
    scenarioId = data.scenario_id;
  }
  const { error } = await supabase.rpc("edit_scenario_record", { p_entity_type: type, p_id: id, p_expected_version: version.parse(form.get("version")), p_patch: patch, p_request_id: z.uuid().parse(form.get("requestId")) });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout"); redirect(type === "scenario" && patch.removed ? "/plan" : `/plan?scenario=${scenarioId}`);
}
export async function updateScenario(form: FormData) {
  await edit(form, "scenario", { name: z.string().trim().min(1).max(120).parse(form.get("name")), description: z.string().trim().max(1000).parse(form.get("description") ?? "") });
}
export async function updateScenarioEvent(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const id = z.uuid().parse(form.get("recordId"));
  const { data, error } = await supabase.from("scenario_overrides").select("currency_code").eq("id", id).eq("workspace_id", workspace.id).single();
  if (error || !data) throw new Error("Scenario event unavailable");
  const starts = z.iso.date().parse(form.get("startsOn")), ends = form.get("endsOn") ? z.iso.date().parse(form.get("endsOn")) : null;
  if (ends && ends < starts) throw new Error("End date cannot precede start date");
  await edit(form, "override", { name: z.string().trim().min(1).max(120).parse(form.get("name")), amount_delta_minor: parseManualAmount(String(form.get("amount") ?? ""), data.currency_code).toString(), cadence: z.enum(["once", "daily", "weekly", "monthly", "yearly"]).parse(form.get("cadence")), starts_on: starts, ends_on: ends });
}
export async function removeScenarioRecord(form: FormData) {
  await edit(form, z.enum(["scenario", "override"]).parse(form.get("entityType")), { removed: true });
}
export async function undoScenarioRecord(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_scenario_record", { p_event_id: z.uuid().parse(form.get("eventId")), p_expected_version: version.parse(form.get("version")) });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout"); redirect("/plan");
}
