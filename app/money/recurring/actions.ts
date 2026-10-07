"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { reviewedLocalTimestamp } from "@/lib/finance/calendar";

import { recurringCadences } from "@/lib/finance/cadences";

const uuid = z.uuid();
const currency = z.string().regex(/^[A-Z]{3}$/);
const receipt = z.object({
  id: uuid, version: z.number().int().min(0).max(2147483647), account_id: uuid,
  posted_on: z.iso.date(), description: z.string(), amount_minor: z.string().regex(/^-?\d+$/),
  currency_code: currency, status: z.literal("posted"), kind: z.literal("ordinary"),
  review_reasons: z.array(z.string()).length(0), merchant_id: uuid.nullable(),
}).strict();

async function decideSeries(form: FormData, decision: "confirmed" | "dismissed") {
  const { supabase } = await requireWorkspace();
  const raw = z.string().max(2_000_000).parse(form.get("sourceEvidence"));
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid source evidence"); }
  const evidence = z.array(receipt).min(3).max(1000).parse(parsed);
  const anchor = uuid.parse(form.get("runAnchorId"));
  if (new Set(evidence.map(row => row.id)).size !== evidence.length || !evidence.some(row => row.id === anchor)) throw new Error("Duplicate sources or missing anchor");
  const limited = z.enum(["true", "false"]).parse(form.get("evidenceLimited")) === "true";
  if (limited && evidence.length !== 1000) throw new Error("Invalid limited evidence");
  const { error } = await supabase.rpc("review_recurring_series", {
    p_decision: decision,
    p_account_id: uuid.parse(form.get("accountId")),
    p_label: z.string().trim().min(1).max(200).parse(form.get("label")),
    p_cadence: z.enum(recurringCadences).parse(form.get("cadence")),
    p_currency_code: currency.parse(form.get("currencyCode")),
    p_evidence: evidence, p_run_anchor_id: anchor, p_evidence_limited: limited,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/money/recurring");
}

export async function confirmSeries(form: FormData) { await decideSeries(form, "confirmed"); }
export async function declineSeries(form: FormData) { await decideSeries(form, "dismissed"); }

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
