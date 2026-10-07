"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { parseManualAmount } from "@/app/money/transactions/input";
import { minorDigits } from "@/lib/finance/fx";
import { calendarDate } from "@/lib/finance/calendar";

export async function createAccount(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const name = z.string().trim().min(1).max(120).parse(form.get("name"));
  const type = z.enum(["checking", "savings", "cash", "credit", "investment", "wallet", "other"]).parse(form.get("type"));
  const currency = z.string().regex(/^[A-Z]{3}$/).parse(form.get("currency"));
  minorDigits(currency);
  const { error } = await supabase.from("accounts").insert({ workspace_id: workspace.id, name, type, currency_code: currency });
  if (error) throw error;
  redirect("/");
}

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
  const reviewed = form.get("reviewedActivity") === "on";
  if (reviewed && asOf !== today) throw new Error("Reviewed activity applies only to today's booked balance");
  const covered = reviewed ? z.array(z.object({ id: z.uuid(), version: z.number().int().nonnegative(),
    amount_minor: z.string().regex(/^-?\d+$/), currency_code: z.string().regex(/^[A-Z]{3}$/),
    posted_on: z.iso.date(), posted_at: z.iso.datetime({ offset: true }).nullable(),
  }).strict()).max(5000).parse(JSON.parse(z.string().max(2_000_000).parse(form.get("coveredTransactions")))) : null;
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
