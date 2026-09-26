"use server";

import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { buildSavedFilters, parseViewId, parseViewName } from "./validate";

function str(value: FormDataEntryValue | null): string | undefined {
  if (value === null) return undefined;
  const text = String(value);
  return text === "" ? undefined : text;
}

async function assertOwned(
  supabase: Awaited<ReturnType<typeof requireWorkspace>>["supabase"],
  workspaceId: string,
  table: "accounts" | "categories" | "merchants",
  id: string | undefined,
  label: string,
) {
  if (!id) return;
  const { data, error } = await supabase
    .from(table)
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) throw new Error(`${label} not found`);
}

/** Save the current filter setup under a name, then open it via opaque id. */
export async function saveTransactionView(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const name = parseViewName(form.get("name"));
  if (!name) throw new Error("Name must be 1–80 characters");
  const filters = buildSavedFilters({
    q: str(form.get("q")),
    from: str(form.get("from")),
    to: str(form.get("to")),
    account: str(form.get("account")),
    status: str(form.get("status")),
    kind: str(form.get("kind")),
    direction: str(form.get("direction")),
    category: str(form.get("category")),
    merchant: str(form.get("merchant")),
    minAmount: str(form.get("minAmount")),
    maxAmount: str(form.get("maxAmount")),
    sort: str(form.get("sort")),
  });
  await assertOwned(supabase, workspace.id, "accounts", filters.accountId, "Account");
  await assertOwned(supabase, workspace.id, "categories", filters.categoryId, "Category");
  await assertOwned(supabase, workspace.id, "merchants", filters.merchantId, "Merchant");
  const { data, error } = await supabase
    .from("transaction_views")
    .insert({ workspace_id: workspace.id, name, filters })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not save view");
  redirect(`/money/transactions?view=${data.id}`);
}

/** Delete a saved view. Workspace scoping keeps this tenant-private. */
export async function deleteTransactionView(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const viewId = parseViewId(form.get("viewId"));
  if (!viewId) throw new Error("Invalid view");
  const { error } = await supabase
    .from("transaction_views")
    .delete()
    .eq("id", viewId)
    .eq("workspace_id", workspace.id);
  if (error) throw new Error(error.message);
  redirect("/money/transactions");
}
