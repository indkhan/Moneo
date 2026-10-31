"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { parseManualAmount } from "@/app/money/transactions/input";
import { calendarDate } from "@/lib/finance/calendar";
import { reviewedCoverage } from "./balance-input";

export async function setManualBalance(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const accountId = z.uuid().parse(form.get("accountId"));
  const asOf = z.iso.date().parse(form.get("asOf"));
  const now = new Date();
  const today = calendarDate(now, workspace.timezone);
  if (asOf > today) throw new Error("Balance date cannot be in the future");
  const { data: account } = await supabase.from("accounts").select("currency_code")
    .eq("workspace_id", workspace.id).eq("id", accountId).maybeSingle();
  if (!account) throw new Error("Account not found");
  const amount = parseManualAmount(String(form.get("amount") ?? ""), account.currency_code);
  const { reviewed, covered } = reviewedCoverage(form, asOf, today);
  const { error } = await supabase.rpc("record_manual_balance", {
    p_account_id: accountId, p_amount_minor: amount.toString(), p_date: asOf, p_reviewed: reviewed,
    p_covered_transactions: covered, p_expected_snapshot_id: z.uuid().nullable().parse(form.get("expectedSnapshotId") || null),
    p_expected_version: z.coerce.number().int().nonnegative().parse(form.get("expectedVersion")),
    p_request_id: z.uuid().parse(form.get("requestId")),
  });
  if (error) throw error;
  redirect("/");
}

export async function undoManualBalance(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_manual_balance", {
    p_snapshot_id: z.uuid().parse(form.get("snapshotId")),
    p_expected_version: z.coerce.number().int().positive().parse(form.get("expectedVersion")),
    p_expected_latest_id: z.uuid().parse(form.get("expectedLatestId")),
    p_expected_latest_version: z.coerce.number().int().positive().parse(form.get("expectedLatestVersion")),
  });
  if (error) throw error;
  redirect("/");
}

export async function confirmRecordedBalance(form: FormData) {
  if (form.get("reviewedActivity") !== "on") throw new Error("Check your bank's booked balance and confirm the listed activity before saving");
  return setManualBalance(form);
}
