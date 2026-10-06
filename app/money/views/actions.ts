"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
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
function currentFilters(form: FormData) {
  return buildSavedFilters({
    q: str(form.get("q")),
    from: str(form.get("from")),
    to: str(form.get("to")),
    account: str(form.get("account")),
    status: str(form.get("status")),
    kind: str(form.get("kind")),
    direction: str(form.get("direction")),
    category: str(form.get("category")),
    merchant: str(form.get("merchant")),
    tag: str(form.get("tag")),
    event: str(form.get("event")),
    minAmount: str(form.get("minAmount")),
    maxAmount: str(form.get("maxAmount")),
    sort: str(form.get("sort")),
  });
}

export async function saveTransactionView(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const name = parseViewName(form.get("name"));
  if (!name) throw new Error("Name must be 1–80 characters");
  const filters = currentFilters(form);
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

export async function updateTransactionViewFilters(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const filters = currentFilters(form);
  await assertOwned(supabase, workspace.id, "accounts", filters.accountId, "Account");
  await assertOwned(supabase, workspace.id, "categories", filters.categoryId, "Category");
  await assertOwned(supabase, workspace.id, "merchants", filters.merchantId, "Merchant");
  const id = z.uuid().parse(form.get("viewId"));
  const { error } = await supabase.rpc("edit_money_metadata", {
    p_entity_type: "transaction_view", p_id: id, p_patch: { filters },
    p_expected_version: z.coerce.number().int().min(1).parse(form.get("version")), p_request_id: z.uuid().parse(form.get("requestId")),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/money/transactions");
  redirect(`/money/transactions?view=${id}`);
}

/** Retain the saved filters and history so removal can be undone. */
export async function deleteTransactionView(form: FormData) {
  const { supabase } = await requireWorkspace();
  const viewId = parseViewId(form.get("viewId"));
  if (!viewId) throw new Error("Invalid view");
  const { error } = await supabase.rpc("edit_money_metadata", {
    p_entity_type: "transaction_view", p_id: viewId,
    p_expected_version: z.coerce.number().int().min(1).parse(form.get("version")),
    p_patch: { removed: true }, p_request_id: z.uuid().parse(form.get("requestId")),
  });
  if (error) throw new Error(error.message);
  redirect("/money/transactions");
}

export async function renameTransactionView(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("edit_money_metadata", {
    p_entity_type: "transaction_view", p_id: z.uuid().parse(form.get("viewId")),
    p_expected_version: z.coerce.number().int().min(1).parse(form.get("version")),
    p_patch: { name: z.string().trim().min(1).max(80).parse(form.get("name")) },
    p_request_id: z.uuid().parse(form.get("requestId")),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/money/transactions");
  redirect("/money/transactions");
}
