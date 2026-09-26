"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";

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
