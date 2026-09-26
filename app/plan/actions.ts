"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { parseAmountMinor } from "@/lib/csv";

const date = z.iso.date();
const assumptionId = z.uuid();
const assumptionCadence = z.enum(["once", "daily", "weekly", "monthly"]);

export async function createGoal(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const name = z.string().trim().min(1).max(120).parse(form.get("name"));
  const currency = z.string().regex(/^[A-Z]{3}$/).parse(form.get("currency"));
  const target = parseAmountMinor(String(form.get("target") ?? ""));
  if (target <= 0n) throw new Error("Goal target must be positive");
  const targetDate = form.get("targetDate") ? date.parse(form.get("targetDate")) : null;
  const { error } = await supabase.from("goals").insert({ workspace_id: workspace.id, name,
    target_minor: target.toString(), currency_code: currency, target_date: targetDate,
    idempotency_key: String(form.get("requestId") ?? "") });
  if (error && error.code !== "23505") throw error;
  redirect("/plan");
}

export async function setAllocation(form: FormData) {
  const { supabase } = await requireWorkspace();
  const goalId = z.uuid().parse(form.get("goalId"));
  const accountId = z.uuid().parse(form.get("accountId"));
  const amount = parseAmountMinor(String(form.get("amount") ?? ""));
  if (amount < 0n) throw new Error("Allocation cannot be negative");
  const { error } = await supabase.rpc("set_goal_allocation", {
    p_goal_id: goalId, p_account_id: accountId, p_amount_minor: amount.toString(),
  });
  if (error) throw new Error(error.message);
  redirect("/plan");
}

export async function addAssumption(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const accountId = z.uuid().parse(form.get("accountId"));
  const name = z.string().trim().min(1).max(120).parse(form.get("name"));
  const cadence = z.enum(["once", "daily", "weekly", "monthly"]).parse(form.get("cadence"));
  const start = date.parse(form.get("startsOn"));
  const amount = parseAmountMinor(String(form.get("amount") ?? ""));
  const { data: account, error: accountError } = await supabase.from("accounts").select("currency_code")
    .eq("workspace_id", workspace.id).eq("id", accountId).single();
  if (accountError || !account) throw new Error("Account not found");
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
  const amount = parseAmountMinor(String(form.get("amount") ?? ""));
  const { data: existing, error: lookupError } = await supabase.from("financial_assumptions")
    .select("id").eq("workspace_id", workspace.id).eq("id", id).single();
  if (lookupError || !existing) throw new Error("Assumption not found");
  const { error } = await supabase.from("financial_assumptions").update({
    name, amount_minor: amount.toString(), kind: amount >= 0n ? "income" : "expense",
    cadence, starts_on: startsOn, ends_on: endsOn, source: "user", confirmed: true,
  }).eq("workspace_id", workspace.id).eq("id", id);
  if (error) throw error;
  redirect("/plan");
}

export async function toggleAssumption(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const id = assumptionId.parse(form.get("assumptionId"));
  const enabled = z.enum(["true", "false"]).parse(form.get("enabled")) === "true";
  const { data: existing, error: lookupError } = await supabase.from("financial_assumptions")
    .select("id").eq("workspace_id", workspace.id).eq("id", id).single();
  if (lookupError || !existing) throw new Error("Assumption not found");
  const { error } = await supabase.from("financial_assumptions").update({
    enabled, source: "user", confirmed: true,
  }).eq("workspace_id", workspace.id).eq("id", id);
  if (error) throw error;
  redirect("/plan");
}

export async function deleteAssumption(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const id = assumptionId.parse(form.get("assumptionId"));
  const { error } = await supabase.from("financial_assumptions")
    .delete().eq("workspace_id", workspace.id).eq("id", id);
  if (error) throw error;
  redirect("/plan");
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
  const cadence = z.enum(["once", "daily", "weekly", "monthly"]).parse(form.get("cadence"));
  const start = date.parse(form.get("startsOn"));
  const amount = parseAmountMinor(String(form.get("amount") ?? ""));
  const { data: account } = await supabase.from("accounts").select("currency_code")
    .eq("workspace_id", workspace.id).eq("id", accountId).maybeSingle();
  const { data: scenario } = await supabase.from("scenarios").select("id")
    .eq("workspace_id", workspace.id).eq("id", scenarioId).maybeSingle();
  if (!account || !scenario) throw new Error("Account or scenario not found");
  const { error } = await supabase.from("scenario_overrides").insert({ workspace_id: workspace.id,
    scenario_id: scenarioId, account_id: accountId, name, amount_delta_minor: amount.toString(),
    currency_code: account.currency_code, cadence, starts_on: start });
  if (error) throw error;
  redirect(`/plan?scenario=${scenarioId}`);
}
