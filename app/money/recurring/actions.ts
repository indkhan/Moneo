"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { reviewedLocalTimestamp } from "@/lib/finance/calendar";

const uuid = z.uuid();
const currency = z.string().regex(/^[A-Z]{3}$/);
const cadence = z.enum(["weekly", "monthly"]);
const minor = z.string().regex(/^-?\d+$/);
const ids = z.array(uuid).min(3).max(1000);

function parseSeries(form: FormData) {
  const transactionIds = String(form.get("transactionIds") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return {
    accountId: uuid.parse(form.get("accountId")),
    label: z.string().trim().min(1).max(200).parse(form.get("label")),
    cadence: cadence.parse(form.get("cadence")),
    currencyCode: currency.parse(form.get("currencyCode")),
    amountMinMinor: minor.parse(form.get("amountMinMinor")),
    amountMaxMinor: minor.parse(form.get("amountMaxMinor")),
    occurrences: z.coerce.number().int().min(3).max(1000).parse(form.get("occurrences")),
    confidence: z.coerce.number().int().min(0).max(100).parse(form.get("confidence")),
    transactionIds: ids.parse(transactionIds),
  };
}

export async function confirmSeries(form: FormData) {
  const { supabase } = await requireWorkspace();
  const series = parseSeries(form);
  if (BigInt(series.amountMinMinor) > BigInt(series.amountMaxMinor)) throw new Error("Invalid amount range");
  if (series.occurrences !== series.transactionIds.length) throw new Error("Occurrences must match evidence count");
  const { error } = await supabase.rpc("confirm_recurring_series", {
    p_account_id: series.accountId,
    p_label: series.label,
    p_cadence: series.cadence,
    p_currency_code: series.currencyCode,
    p_amount_min_minor: series.amountMinMinor,
    p_amount_max_minor: series.amountMaxMinor,
    p_occurrences: series.occurrences,
    p_confidence: series.confidence,
    p_transaction_ids: series.transactionIds,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/money/recurring");
  redirect("/money/recurring");
}

export async function declineSeries(form: FormData) {
  const { supabase } = await requireWorkspace();
  const series = parseSeries(form);
  if (BigInt(series.amountMinMinor) > BigInt(series.amountMaxMinor)) throw new Error("Invalid amount range");
  if (series.occurrences !== series.transactionIds.length) throw new Error("Occurrences must match evidence count");
  const { error } = await supabase.rpc("decline_recurring_series", {
    p_account_id: series.accountId,
    p_label: series.label,
    p_cadence: series.cadence,
    p_currency_code: series.currencyCode,
    p_amount_min_minor: series.amountMinMinor,
    p_amount_max_minor: series.amountMaxMinor,
    p_occurrences: series.occurrences,
    p_confidence: series.confidence,
    p_transaction_ids: series.transactionIds,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/money/recurring");
  redirect("/money/recurring");
}

const versionedId = z.string().transform(value => {
  const [id, version] = value.split(":");
  return { id: uuid.parse(id), version: z.coerce.number().int().min(0).parse(version) };
});
export async function associateOccurrence(form: FormData) {
  const assumption = versionedId.parse(form.get("assumption"));
  const transaction = versionedId.parse(form.get("transaction"));
  const scheduledOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(form.get("scheduledOn"));
  reviewedLocalTimestamp(`${scheduledOn}T00:00:00`, "UTC");
  const fulfillment = z.enum(["full", "partial"]).parse(form.get("fulfillment"));
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("record_recurring_occurrence", {
    p_assumption_id: assumption.id, p_assumption_version: assumption.version, p_scheduled_on: scheduledOn,
    p_transaction_id: transaction.id, p_transaction_version: transaction.version, p_completes_occurrence: fulfillment === "full",
  });
  if (error) throw new Error(error.message);
  revalidatePath("/money/recurring"); revalidatePath("/plan"); revalidatePath("/");
}
export async function undoOccurrence(form: FormData) {
  const id = uuid.parse(form.get("settlementId"));
  const version = z.coerce.number().int().min(1).parse(form.get("version"));
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_recurring_occurrence", { p_settlement_id: id, p_version: version });
  if (error) throw new Error(error.message);
  revalidatePath("/money/recurring"); revalidatePath("/plan"); revalidatePath("/");
}
