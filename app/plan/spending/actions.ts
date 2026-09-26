"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { parseAmountMinor } from "@/lib/csv";

export async function saveSpendingPlan(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const categoryId = z.uuid().parse(form.get("categoryId"));
  const currency = z.string().regex(/^[A-Z]{3}$/).parse(form.get("currency"));
  const limit = parseAmountMinor(String(form.get("amount") ?? ""));
  if (limit <= 0n) throw new Error("Spending limit must be positive");
  const { data: category } = await supabase.from("categories").select("id")
    .eq("workspace_id", workspace.id).eq("id", categoryId).maybeSingle();
  if (!category) throw new Error("Category not found");
  // Target only: one monthly limit per category + currency. Never touches
  // account balances or goal allocations.
  const { error } = await supabase.from("spending_plans").upsert({
    workspace_id: workspace.id, category_id: categoryId, currency_code: currency,
    limit_minor: limit.toString(), enabled: true, updated_at: new Date().toISOString(),
  }, { onConflict: "workspace_id,category_id,currency_code" });
  if (error) throw error;
  redirect("/plan/spending");
}

export async function toggleSpendingPlan(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const planId = z.uuid().parse(form.get("planId"));
  const enabled = z.enum(["true", "false"]).parse(form.get("enabled")) === "true";
  const { error } = await supabase.from("spending_plans")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspace.id).eq("id", planId);
  if (error) throw error;
  redirect("/plan/spending");
}
