"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/auth";
import { parseManualAmount } from "@/app/money/transactions/input";

async function editPlan(form: FormData, patch: Record<string, unknown>) {
  const { supabase } = await requireWorkspace();
  const id = z.uuid().parse(form.get("planId"));
  const version = z.coerce.number().int().min(1).max(2147483647).parse(form.get("version"));
  const requestId = z.uuid().parse(form.get("requestId"));
  const { error } = await supabase.rpc("edit_spending_plan", { p_id: id, p_expected_version: version, p_patch: patch, p_request_id: requestId });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/plan/spending");
}

export async function saveSpendingPlan(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  if (form.get("planId")) {
    const planId = z.uuid().parse(form.get("planId"));
    const { data: plan, error } = await supabase.from("spending_plans").select("currency_code")
      .eq("workspace_id", workspace.id).eq("id", planId).maybeSingle();
    if (error || !plan) throw new Error("Spending plan not found");
    const limit = parseManualAmount(String(form.get("amount") ?? ""), plan.currency_code);
    if (limit <= 0n) throw new Error("Spending limit must be positive");
    await editPlan(form, { limit_minor: limit.toString() });
    return;
  }
  const categoryId = z.uuid().parse(form.get("categoryId"));
  const currency = z.string().regex(/^[A-Z]{3}$/).parse(form.get("currency"));
  const limit = parseManualAmount(String(form.get("amount") ?? ""), currency);
  if (limit <= 0n) throw new Error("Spending limit must be positive");
  const { data: category } = await supabase.from("categories").select("id")
    .eq("workspace_id", workspace.id).eq("id", categoryId).maybeSingle();
  if (!category) throw new Error("Category not found");
  // Target only: one monthly limit per category + currency. Never touches
  // account balances or goal allocations.
  const { error } = await supabase.from("spending_plans").insert({
    workspace_id: workspace.id, category_id: categoryId, currency_code: currency,
    limit_minor: limit.toString(), enabled: true, updated_at: new Date().toISOString(),
  });
  if (error?.code === "23505") throw new Error("A plan already exists for this category and currency; edit its limit above");
  if (error) throw error;
  revalidatePath("/", "layout");
  redirect("/plan/spending");
}

export async function toggleSpendingPlan(form: FormData) {
  const enabled = z.enum(["true", "false"]).parse(form.get("enabled")) === "true";
  await editPlan(form, { enabled });
}

export async function setRollover(form: FormData) {
  const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(form.get("rolloverFrom"));
  await editPlan(form, { rollover: form.get("rollover") === "on", rollover_from: `${month}-01` });
}
