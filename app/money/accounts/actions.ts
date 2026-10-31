"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { parseManualAmount } from "@/app/money/transactions/input";
import { reviewedCoverage } from "@/app/balance-input";
import { accountTypes } from "./naming";
import { minorDigits } from "@/lib/finance/fx";
import { linkOwnTransfers, normalizeIban } from "@/lib/finance/own-transfers";

const version = z.coerce.number().int().min(1).max(2147483646);
const accountType = z.enum(accountTypes);

export async function editAccount(_state: { error?: string }, form: FormData): Promise<{ error?: string }> {
  try {
  const { supabase } = await requireWorkspace();
  const patch = form.get("operation") === "archive" ? { archived: true }
    : form.get("operation") === "restore" ? { archived: false }
    : { name: z.string().trim().min(1).max(120).parse(form.get("name")), type: accountType.parse(form.get("type")) };
  const { error } = await supabase.rpc("edit_money_metadata", {
    p_entity_type: "account", p_id: z.uuid().parse(form.get("accountId")),
    p_expected_version: version.parse(form.get("version")), p_patch: patch, p_request_id: z.uuid().parse(form.get("requestId")),
  });
  if (error) throw new Error(error.message);
  } catch (error) {
    return { error: error instanceof z.ZodError ? "Enter a name of 1 to 120 characters" : error instanceof Error ? error.message : "Could not update account" };
  }
  revalidatePath("/", "layout");
  redirect("/money/accounts");
}

export async function undoMoneyMetadata(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_money_metadata", {
    p_event_id: z.uuid().parse(form.get("eventId")), p_expected_version: version.parse(form.get("version")),
    p_request_id: z.uuid().parse(form.get("requestId")),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/money/accounts");
}

// Same RPC and confirmation of today's activity as Home's manual balance, returning here.
export async function updateBalance(_state: { error?: string }, form: FormData): Promise<{ error?: string }> {
  try {
    const { supabase, workspace } = await requireWorkspace();
    const accountId = z.uuid().parse(form.get("accountId"));
    const asOf = z.iso.date().parse(form.get("asOf"));
    const today = calendarDate(new Date(), workspace.timezone);
    if (asOf > today) throw new Error("Balance date cannot be in the future");
    const { reviewed, covered } = reviewedCoverage(form, asOf, today);
    const { data: account } = await supabase.from("accounts").select("currency_code").eq("workspace_id", workspace.id).eq("id", accountId).maybeSingle();
    if (!account) throw new Error("Account not found");
    const { error } = await supabase.rpc("record_manual_balance", {
      p_account_id: accountId, p_amount_minor: parseManualAmount(String(form.get("amount") ?? ""), account.currency_code).toString(),
      p_date: asOf, p_reviewed: reviewed, p_covered_transactions: covered,
      p_expected_snapshot_id: z.uuid().nullable().parse(form.get("expectedSnapshotId") || null),
      p_expected_version: z.coerce.number().int().nonnegative().parse(form.get("expectedVersion")),
      p_request_id: z.uuid().parse(form.get("requestId")),
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    return { error: error instanceof z.ZodError ? "Check the amount and date" : error instanceof Error ? error.message : "Could not update balance" };
  }
  revalidatePath("/", "layout");
  redirect("/money/accounts");
}

export async function undoBalance(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_manual_balance", {
    p_snapshot_id: z.uuid().parse(form.get("snapshotId")),
    p_expected_version: z.coerce.number().int().positive().parse(form.get("expectedVersion")),
    p_expected_latest_id: z.uuid().parse(form.get("expectedLatestId")),
    p_expected_latest_version: z.coerce.number().int().positive().parse(form.get("expectedLatestVersion")),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/money/accounts");
}

export async function addAccount(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const currency = z.string().regex(/^[A-Z]{3}$/).parse(String(form.get("currency") ?? "").trim().toUpperCase());
  minorDigits(currency);
  const { error } = await supabase.from("accounts").insert({ workspace_id: workspace.id, name: z.string().trim().min(1).max(120).parse(form.get("name")),
    type: accountType.parse(form.get("type")), currency_code: currency });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/money/accounts");
}

function transfersRedirect(result: { linked: number; marked: number; skipped: number }): never {
  revalidatePath("/", "layout");
  redirect(`/money/accounts?${new URLSearchParams({ transfers: `${result.linked}-${result.marked}-${result.skipped}` })}#own-accounts`);
}

// Saving an own IBAN immediately looks for the transfers it explains.
export async function addOwnAccount(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const iban = normalizeIban(String(form.get("iban") ?? ""));
  if (!iban) throw new Error("Enter a valid IBAN");
  const accountId = z.union([z.uuid(), z.literal("")]).parse(form.get("accountId") ?? "") || null;
  const { error } = await supabase.from("own_account_identifiers").insert({ workspace_id: workspace.id, iban, account_id: accountId,
    label: z.string().trim().min(1).max(120).parse(form.get("label")) });
  if (error) throw new Error(error.code === "23505" ? "That IBAN is already saved" : error.message);
  transfersRedirect(await linkOwnTransfers(supabase, workspace.id));
}

// Removing an IBAN keeps transfers already linked; each can be undone from its transaction.
export async function removeOwnAccount(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const { error } = await supabase.from("own_account_identifiers").delete().eq("workspace_id", workspace.id).eq("id", z.uuid().parse(form.get("id")));
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/money/accounts#own-accounts");
}

export async function findTransfersBetweenOwnAccounts() {
  const { supabase, workspace } = await requireWorkspace();
  transfersRedirect(await linkOwnTransfers(supabase, workspace.id));
}
