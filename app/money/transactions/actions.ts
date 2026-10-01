"use server";

import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { bulkInput, parseManualAmount, versionedRows } from "./input";

const uuidPattern = /^[0-9a-f-]{36}$/i;

function linkInput(form: FormData) {
  const id = String(form.get("id") ?? "");
  const version = Number(form.get("version"));
  if (!uuidPattern.test(id) || !Number.isSafeInteger(version)) throw new Error("Invalid correction");
  return { id, version };
}
function returnPath(form: FormData) {
  const query = String(form.get("query") ?? "");
  const params = new URLSearchParams(query);
  params.delete("transaction");
  return `/money/transactions?${params}`;
}

export async function correctTransaction(form: FormData) {
  const { supabase } = await requireWorkspace();
  const id = String(form.get("id") ?? "");
  const version = Number(form.get("version"));
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isSafeInteger(version)) throw new Error("Invalid correction");
  const { error } = await supabase.rpc("correct_transaction", {
    p_transaction_id: id,
    p_expected_version: version,
    p_category_name: String(form.get("category") ?? ""),
    p_note: String(form.get("note") ?? ""),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect(`${returnPath(form)}&transaction=${id}`);
}

export async function undoCorrection(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const eventId = String(form.get("eventId") ?? "");
  const transactionId = String(form.get("transactionId") ?? "");
  const version = Number(form.get("version"));
  if (!/^[0-9a-f-]{36}$/i.test(eventId) || !/^[0-9a-f-]{36}$/i.test(transactionId) || !Number.isSafeInteger(version)) throw new Error("Invalid correction");
  const { data: event, error: lookupError } = await supabase.from("correction_events").select("after")
    .eq("workspace_id", workspace.id).eq("id", eventId).maybeSingle();
  if (lookupError || !event) throw new Error("Correction not found");
  const operation = (event.after as { operation?: string }).operation;
  const procedure = operation === "metadata" ? "undo_transaction_metadata" : operation === "classification_review" ? "undo_transaction_classification" : "undo_transaction_correction";
  const { error } = await supabase.rpc(procedure, {
    p_event_id: eventId,
    p_expected_version: version,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect(`${returnPath(form)}&transaction=${transactionId}`);
}

const version = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(2147483647));

export async function createManualTransaction(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const accountId = z.uuid().parse(form.get("accountId"));
  const { data: account, error: accountError } = await supabase.from("accounts").select("currency_code")
    .eq("workspace_id", workspace.id).eq("id", accountId).maybeSingle();
  if (accountError || !account) throw new Error("Account not found");
  const amount = parseManualAmount(z.string().parse(form.get("amount")), account.currency_code);
  const { data, error } = await supabase.rpc("create_manual_transaction", {
    p_account_id: accountId, p_posted_on: z.iso.date().parse(form.get("postedOn")),
    p_description: z.string().trim().min(1).max(500).parse(form.get("description")), p_amount_minor: amount.toString(),
    p_status: z.enum(["posted", "pending"]).parse(form.get("status")),
    p_category_id: form.get("categoryId") ? z.uuid().parse(form.get("categoryId")) : null,
    p_note: z.string().max(2000).parse(form.get("note") ?? ""), p_request_id: z.uuid().parse(form.get("requestId")),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect(data.id ? `/money/transactions?transaction=${z.uuid().parse(data.id)}` : "/money/transactions");
}

export async function undoManualTransaction(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_manual_transaction", {
    p_entry_id: z.uuid().parse(form.get("entryId")), p_entry_version: version.parse(form.get("entryVersion")), p_expected_version: version.parse(form.get("version")),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/money/transactions");
}

export async function restoreManualTransaction(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { data, error } = await supabase.rpc("restore_manual_transaction", {
    p_entry_id: z.uuid().parse(form.get("entryId")), p_entry_version: version.parse(form.get("entryVersion")),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect(`/money/transactions?transaction=${z.uuid().parse(data)}`);
}

export async function bulkEditTransactions(form: FormData) {
  const { supabase } = await requireWorkspace();
  const input = bulkInput({ rows: JSON.parse(z.string().max(10000).parse(form.get("rows"))),
    requestId: form.get("requestId"), confirmed: form.get("confirmed"), mode: form.get("mode"), value: form.get("value") });
  const { error } = await supabase.rpc("bulk_edit_transactions", { p_rows: input.rows, p_patch: input.patch, p_request_id: input.requestId });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect(returnPath(form));
}

export async function undoTransactionBatch(form: FormData) {
  const { supabase } = await requireWorkspace();
  const rows = versionedRows.parse(JSON.parse(z.string().max(10000).parse(form.get("rows"))));
  const { error } = await supabase.rpc("undo_transaction_batch", { p_batch_id: z.uuid().parse(form.get("batchId")), p_rows: rows });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect(returnPath(form));
}

export async function markTransfer(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { id, version } = linkInput(form);
  const counterpartId = String(form.get("counterpartId") ?? "");
  if (!uuidPattern.test(counterpartId) || counterpartId === id) throw new Error("Select a valid counterpart transaction");
  const { error } = await supabase.rpc("mark_transaction_transfer", {
    p_transaction_id: id,
    p_expected_version: version,
    p_counterpart_id: counterpartId,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect(`${returnPath(form)}&transaction=${id}`);
}

export async function markRefund(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { id, version } = linkInput(form);
  const rawOriginal = String(form.get("originalId") ?? "");
  const originalId = rawOriginal === "" ? null : rawOriginal;
  if (originalId !== null && (!uuidPattern.test(originalId) || originalId === id)) throw new Error("Select a valid original transaction");
  const { error } = await supabase.rpc("mark_transaction_refund", {
    p_transaction_id: id,
    p_expected_version: version,
    p_original_id: originalId,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect(`${returnPath(form)}&transaction=${id}`);
}

export async function clearLink(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { id, version } = linkInput(form);
  const { error } = await supabase.rpc("clear_transaction_link", {
    p_transaction_id: id,
    p_expected_version: version,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect(`${returnPath(form)}&transaction=${id}`);
}
