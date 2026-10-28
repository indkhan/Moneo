"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { reviewedLocalTimestamp } from "@/lib/finance/calendar";
import { recurringCadences } from "@/lib/finance/cadences";
import { parseManualAmount } from "@/app/money/transactions/input";
import { createSchedule, decideSeries, editSchedule, removeSchedule, scheduleFields, type ScheduleFields } from "./schedules";

/** What a recurring form shows after submitting: an error to fix, or done. Failures never reach the error page. */
export type ActionState = { error?: string; done?: number };

const uuid = z.uuid();
const currency = z.string().regex(/^[A-Z]{3}$/);
// Compact expected versions keep 1000-source forms well below Next's default
// 1MB body limit. Owned full receipts are read and validated under RPC locks.
const receipt = z.object({id: uuid, version: z.number().int().min(0).max(2147483647)}).strict();
const receiptPayload = z.string().max(128000).refine(value => Buffer.byteLength(value,"utf8") <= 128000,"Evidence payload too large");

async function run(work: () => Promise<unknown>): Promise<ActionState> {
  try { await work(); }
  catch (cause) {
    if (cause instanceof z.ZodError) return { error: cause.issues[0]?.message ?? "Check the form" };
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
  revalidatePath("/", "layout");
  return { done: Date.now() };
}

function seriesFrom(form: FormData) {
  const raw = receiptPayload.parse(form.get("sourceEvidence"));
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid source evidence"); }
  const evidence = z.array(receipt).min(3).max(1000).parse(parsed);
  const anchor = uuid.parse(form.get("runAnchorId"));
  if (new Set(evidence.map(row => row.id)).size !== evidence.length || !evidence.some(row => row.id === anchor)) throw new Error("Duplicate sources or missing anchor");
  const evidenceLimited = z.enum(["true", "false"]).parse(form.get("evidenceLimited")) === "true";
  if (evidenceLimited && evidence.length !== 1000) throw new Error("Invalid limited evidence");
  return { accountId: uuid.parse(form.get("accountId")), label: z.string().trim().min(1).max(200).parse(form.get("label")), cadence: z.enum(recurringCadences).parse(form.get("cadence")),
    currencyCode: currency.parse(form.get("currencyCode")), evidence, runAnchorId: anchor, evidenceLimited };
}

/** The editable fields of the dialog: a positive amount plus a direction, so "coming in" never needs a minus sign. */
function fieldsFrom(form: FormData, currencyCode: string): ScheduleFields {
  const amount = parseManualAmount(String(form.get("amount") ?? ""), currencyCode);
  if (amount <= 0n) throw new Error("Enter an amount above zero");
  const direction = z.enum(["out", "in"]).parse(form.get("direction"));
  return scheduleFields.parse({ name: form.get("name"), amountMinor: (direction === "out" ? -amount : amount).toString(), cadence: form.get("scheduleCadence"),
    startsOn: form.get("startsOn"), category: String(form.get("category") ?? "").trim() || null });
}

/** Only what the person changed: an untouched prefilled date keeps the schedule's own calendar. */
function changesFrom(form: FormData, currencyCode: string): Partial<ScheduleFields> {
  const { startsOn, ...rest } = fieldsFrom(form, currencyCode);
  return startsOn === form.get("shownStartsOn") ? rest : { ...rest, startsOn };
}

export async function confirmSeries(_: ActionState, form: FormData) {
  return run(async () => {
    const series = seriesFrom(form);
    await decideSeries(await requireWorkspace(), series, "confirmed", form.has("amount") ? changesFrom(form, series.currencyCode) : {});
  });
}
export async function declineSeries(_: ActionState, form: FormData) {
  return run(async () => { await decideSeries(await requireWorkspace(), seriesFrom(form), "dismissed"); });
}

export async function addSchedule(_: ActionState, form: FormData) {
  return run(async () => {
    const context = await requireWorkspace();
    const accountId = uuid.parse(form.get("accountId"));
    const { data: account } = await context.supabase.from("accounts").select("currency_code").eq("workspace_id", context.workspace.id).eq("id", accountId).maybeSingle();
    if (!account) throw new Error("Account not found");
    await createSchedule(context, accountId, fieldsFrom(form, account.currency_code));
  });
}
export async function updateSchedule(_: ActionState, form: FormData) {
  return run(async () => {
    await editSchedule(await requireWorkspace(), uuid.parse(form.get("assumptionId")), changesFrom(form, currency.parse(form.get("currencyCode"))), crypto.randomUUID());
  });
}
export async function deleteSchedule(_: ActionState, form: FormData) {
  return run(async () => { await removeSchedule(await requireWorkspace(), uuid.parse(form.get("assumptionId")), crypto.randomUUID()); });
}

const versionedId = z.string().transform(value => {
  const [id, version] = value.split(":");
  return { id: uuid.parse(id), version: z.coerce.number().int().min(0).parse(version) };
});
export async function associateOccurrence(_: ActionState, form: FormData) {
  return run(async () => {
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
  });
}
export async function undoOccurrence(_: ActionState, form: FormData) {
  return run(async () => {
    const id = uuid.parse(form.get("settlementId"));
    const version = z.coerce.number().int().min(1).parse(form.get("version"));
    const { supabase } = await requireWorkspace();
    const { error } = await supabase.rpc("undo_recurring_occurrence", { p_settlement_id: id, p_version: version });
    if (error) throw new Error(error.message);
  });
}
