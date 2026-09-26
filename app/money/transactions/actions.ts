"use server";

import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";

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
  redirect(`${returnPath(form)}&transaction=${id}`);
}

export async function undoCorrection(form: FormData) {
  const { supabase } = await requireWorkspace();
  const eventId = String(form.get("eventId") ?? "");
  const transactionId = String(form.get("transactionId") ?? "");
  const version = Number(form.get("version"));
  if (!/^[0-9a-f-]{36}$/i.test(eventId) || !/^[0-9a-f-]{36}$/i.test(transactionId) || !Number.isSafeInteger(version)) throw new Error("Invalid correction");
  const { error } = await supabase.rpc("undo_transaction_correction", {
    p_event_id: eventId,
    p_expected_version: version,
  });
  if (error) throw new Error(error.message);
  redirect(`${returnPath(form)}&transaction=${transactionId}`);
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
  redirect(`${returnPath(form)}&transaction=${id}`);
}
