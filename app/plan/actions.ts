"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { scheduleCadences } from "@/lib/finance/cadences";
import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/auth";
import { parseManualAmount } from "@/app/money/transactions/input";
import { calendarDate } from "@/lib/finance/calendar";

const date = z.iso.date();
const assumptionId = z.uuid();
const assumptionCadence = z.enum(scheduleCadences);

export async function updateGoalPlan(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const id = z.uuid().parse(form.get("goalId"));
  const { data: goal, error: lookupError } = await supabase.from("goals").select("currency_code").eq("workspace_id", workspace.id).eq("id", id).single();
  if (lookupError || !goal) throw new Error("Goal unavailable");
  const amount = (name: string) => parseManualAmount(String(form.get(name) ?? ""), goal.currency_code);
  const target = amount("target"), monthly = amount("monthly");
  const saved = String(form.get("saved") ?? "").trim() ? amount("saved") : null;
  if (target <= 0n || monthly < 0n || (saved !== null && saved < 0n)) throw new Error("Goal amounts must be nonnegative and the target positive");
  const optionalDate = (name: string) => form.get(name) ? date.parse(form.get(name)) : null;
  const savedAsOf = optionalDate("savedAsOf"), startsOn = optionalDate("startsOn");
  if ((saved === null) !== (savedAsOf === null)) throw new Error("Recorded savings need their evidence date; leave both blank for unknown savings");
  if (savedAsOf && savedAsOf > calendarDate(new Date(), workspace.timezone)) throw new Error("Savings evidence cannot be in the future");
  if (monthly > 0n && !startsOn) throw new Error("A contribution plan needs its first payment date");
  const { error } = await supabase.rpc("edit_goal_plan", {
    p_goal_id: id, p_expected_version: z.coerce.number().int().min(0).max(2147483646).parse(form.get("version")), p_request_id: z.uuid().parse(form.get("requestId")),
    p_patch: { name: z.string().trim().min(1).max(120).parse(form.get("name")), target_minor: target.toString(), target_date: optionalDate("targetDate"),
      priority: z.coerce.number().int().min(0).max(100).parse(form.get("priority")), status: z.enum(["active", "paused", "completed", "archived"]).parse(form.get("status")),
      notes: z.string().trim().max(1000).parse(form.get("notes") ?? ""), planned_monthly_minor: monthly.toString(), contribution_starts_on: startsOn,
      recorded_saved_minor: saved?.toString() ?? null, saved_as_of: savedAsOf },
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout"); redirect("/plan");
}

export async function undoGoalPlan(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_goal_plan", { p_event_id: z.uuid().parse(form.get("eventId")), p_expected_version: z.coerce.number().int().min(0).max(2147483646).parse(form.get("version")) });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout"); redirect("/plan");
}

async function editAssumption(form: FormData, patch: Record<string, unknown>) {
  const { supabase } = await requireWorkspace();
  const id = assumptionId.parse(form.get("assumptionId"));
  const version = z.coerce.number().int().min(1).max(2147483647).parse(form.get("version"));
  const requestId = z.uuid().parse(form.get("requestId"));
  const { error } = await supabase.rpc("edit_assumption", {
    p_id: id, p_expected_version: version, p_patch: patch, p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/plan");
}

export async function createGoal(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const name = z.string().trim().min(1).max(120).parse(form.get("name"));
  const currency = z.string().regex(/^[A-Z]{3}$/).parse(form.get("currency"));
  const target = parseManualAmount(String(form.get("target") ?? ""), currency);
  if (target <= 0n) throw new Error("Goal target must be positive");
  const targetDate = form.get("targetDate") ? date.parse(form.get("targetDate")) : null;
  const { error } = await supabase.from("goals").insert({ workspace_id: workspace.id, name,
    target_minor: target.toString(), currency_code: currency, target_date: targetDate,
    idempotency_key: String(form.get("requestId") ?? "") });
  if (error && error.code !== "23505") throw error;
  revalidatePath("/", "layout");
  redirect("/plan");
}

export async function setAllocation(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const goalId = z.uuid().parse(form.get("goalId"));
  const accountId = z.uuid().parse(form.get("accountId"));
  const { data: goal } = await supabase.from("goals").select("currency_code")
    .eq("workspace_id", workspace.id).eq("id", goalId).maybeSingle();
  if (!goal) throw new Error("Goal not found");
  const amount = parseManualAmount(String(form.get("amount") ?? ""), goal.currency_code);
  if (amount < 0n) throw new Error("Allocation cannot be negative");
  const { error } = await supabase.rpc("reserve_goal_funds", {
    p_goal_id: goalId, p_account_id: accountId, p_amount_minor: amount.toString(),
    p_expected_version: z.coerce.number().int().min(0).max(2147483646).parse(form.get("version")),
    p_request_id: z.uuid().parse(form.get("requestId")),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/plan");
}

export async function undoReservation(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_goal_reservation", {
    p_event_id: z.uuid().parse(form.get("eventId")),
    p_expected_version: z.coerce.number().int().min(1).max(2147483646).parse(form.get("version")),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout"); redirect("/plan");
}

export async function addAssumption(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const accountId = z.uuid().parse(form.get("accountId"));
  const name = z.string().trim().min(1).max(120).parse(form.get("name"));
  const cadence = z.enum(scheduleCadences).parse(form.get("cadence"));
  const start = date.parse(form.get("startsOn"));
  const { data: account, error: accountError } = await supabase.from("accounts").select("currency_code")
    .eq("workspace_id", workspace.id).eq("id", accountId).is("archived_at", null).single();
  if (accountError || !account) throw new Error("Account not found");
  const amount = parseManualAmount(String(form.get("amount") ?? ""), account.currency_code);
  const { error } = await supabase.from("financial_assumptions").insert({
    workspace_id: workspace.id, account_id: accountId, name, kind: amount >= 0n ? "income" : "expense",
    amount_minor: amount.toString(), currency_code: account.currency_code, cadence,
    starts_on: start, source: "user", confirmed: true, enabled: true,
  });
  if (error) throw error;
  redirect("/plan");
}

export async function updateAssumption(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const id = assumptionId.parse(form.get("assumptionId"));
  const name = z.string().trim().min(1).max(120).parse(form.get("name"));
  const cadence = assumptionCadence.parse(form.get("cadence"));
  const startsOn = date.parse(form.get("startsOn"));
  const rawEndsOn = String(form.get("endsOn") ?? "").trim();
  const endsOn = rawEndsOn ? date.parse(rawEndsOn) : null;
  if (endsOn && endsOn < startsOn) throw new Error("End date cannot be before start date");
  const { data: existing, error: lookupError } = await supabase.from("financial_assumptions")
    .select("id, currency_code").eq("workspace_id", workspace.id).eq("id", id).single();
  if (lookupError || !existing) throw new Error("Assumption not found");
  const amount = parseManualAmount(String(form.get("amount") ?? ""), existing.currency_code);
  await editAssumption(form, {
    name, amount_minor: amount.toString(), kind: amount >= 0n ? "income" : "expense",
    cadence, starts_on: startsOn, ends_on: endsOn,
  });
}

export async function toggleAssumption(form: FormData) {
  const enabled = z.enum(["true", "false"]).parse(form.get("enabled")) === "true";
  await editAssumption(form, { enabled });
}

export async function deleteAssumption(form: FormData) {
  await editAssumption(form, { removed: true });
}

export async function undoPlanningEvent(form: FormData) {
  const { supabase } = await requireWorkspace();
  const eventId = z.uuid().parse(form.get("eventId"));
  const version = z.coerce.number().int().min(1).max(2147483647).parse(form.get("version"));
  const destination = z.enum(["/plan", "/plan/spending"]).parse(form.get("destination") ?? "/plan");
  const { error } = await supabase.rpc("undo_planning_event", { p_event_id: eventId, p_expected_version: version });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect(destination);
}

export async function createScenario(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const name = z.string().trim().min(1).max(120).parse(form.get("name"));
  const { data, error } = await supabase.from("scenarios").insert({ workspace_id: workspace.id, name })
    .select("id").single();
  if (error) throw error;
  redirect(`/plan?scenario=${data.id}`);
}

export async function addScenarioEvent(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const scenarioId = z.uuid().parse(form.get("scenarioId"));
  const accountId = z.uuid().parse(form.get("accountId"));
  const name = z.string().trim().min(1).max(120).parse(form.get("name"));
  const cadence = z.enum(scheduleCadences).parse(form.get("cadence"));
  const start = date.parse(form.get("startsOn"));
  const { data: account } = await supabase.from("accounts").select("currency_code")
    .eq("workspace_id", workspace.id).eq("id", accountId).is("archived_at", null).maybeSingle();
  const { data: scenario } = await supabase.from("scenarios").select("id")
    .eq("workspace_id", workspace.id).eq("id", scenarioId).is("removed_at", null).maybeSingle();
  if (!account || !scenario) throw new Error("Account or scenario not found");
  const amount = parseManualAmount(String(form.get("amount") ?? ""), account.currency_code);
  const { error } = await supabase.from("scenario_overrides").insert({ workspace_id: workspace.id,
    scenario_id: scenarioId, account_id: accountId, name, amount_delta_minor: amount.toString(),
    currency_code: account.currency_code, cadence, starts_on: start });
  if (error) throw error;
  redirect(`/plan?scenario=${scenarioId}`);
}
