"use server";

import { safely, type SafeState } from "@/lib/safe-action";
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
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { closingAnswerSchema, closingPlan } from "@/lib/finance/account-closing";
import { stableId } from "@/lib/import/row";

const version = z.coerce.number().int().min(1).max(2147483646);
const accountType = z.enum(accountTypes);

export async function editAccount(_state: { error?: string }, form: FormData): Promise<{ error?: string }> {
  try {
  const { supabase, workspace } = await requireWorkspace();
  // Asked again here, not only in the form: archiving can't drop money from net worth without an answer.
  if (form.get("operation") === "archive") {
    const evidence = await loadBalanceEvidence(supabase, workspace.id);
    const account = resolveBalances(evidence.accounts.filter(row => row.id === form.get("accountId")), evidence.snapshots, evidence.ledger, evidence.asOf, workspace.timezone)[0];
    if (account?.balance.status === "ambiguous") throw new Error("Settle this account's balance before archiving it");
    if (account && BigInt(account.balance.amount_minor ?? "0") !== 0n) throw new Error("This account still holds money. Say what happens to it first.");
  }
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
  redirect(`/money/accounts?saved=account:${String(form.get("accountId"))}#account-${String(form.get("accountId"))}`);
}

/**
 * Archives an account that still holds money, after the owner said where it went. Each row uses the same audited tools as
 * by hand, keyed by this request, so pressing again after a failure can't add the money twice. Restoring the account
 * leaves these rows in place; each can be undone from its transaction.
 */
export async function archiveWithAnswer(_state: { error?: string }, form: FormData): Promise<{ error?: string }> {
  const accountId = String(form.get("accountId"));
  try {
    const { supabase, workspace } = await requireWorkspace();
    const requestId = z.uuid().parse(form.get("requestId"));
    const answer = closingAnswerSchema.parse({ outcome: form.get("outcome"), ...(form.get("targetAccountId") ? { targetAccountId: form.get("targetAccountId") } : {}) });
    const evidence = await loadBalanceEvidence(supabase, workspace.id);
    const account = resolveBalances(evidence.accounts.filter(row => row.id === accountId), evidence.snapshots, evidence.ledger, evidence.asOf, workspace.timezone)[0];
    if (!account || account.archived_at) throw new Error("Account not found");
    if (account.balance.amount_minor === null) throw new Error("Settle this account's balance before archiving it");
    const plan = closingPlan(account, BigInt(account.balance.amount_minor), answer, evidence.accounts);
    const today = calendarDate(new Date(evidence.asOf), workspace.timezone);
    let targetId = plan.target?.id ?? null;
    if (plan.createCash) {
      const created = await supabase.from("accounts").upsert({ id: stableId(`${requestId}:cash`), workspace_id: workspace.id, name: "Cash", type: "cash", currency_code: account.currency_code }, { onConflict: "id" }).select("id").single();
      if (created.error) throw new Error(created.error.message);
      targetId = created.data.id as string;
      // A new account counts from a balance; the money moved in today is what's in it.
      const dayBefore = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const opening = await supabase.rpc("record_manual_balance", { p_account_id: targetId, p_amount_minor: "0", p_date: dayBefore, p_reviewed: false, p_covered_transactions: null, p_expected_snapshot_id: null, p_expected_version: 0, p_request_id: stableId(`${requestId}:opening`) });
      if (opening.error) throw new Error(opening.error.message);
    }
    const post = async (target: string, row: { amountMinor: bigint; description: string }, part: string) => {
      const { data, error } = await supabase.rpc("create_manual_transaction", { p_account_id: target, p_posted_on: today, p_description: row.description, p_amount_minor: row.amountMinor.toString(), p_status: "posted", p_category_id: null, p_note: "Added when archiving an account", p_request_id: stableId(`${requestId}:${part}`) });
      if (error) throw new Error(error.message);
      const saved = await supabase.from("transactions").select("id, kind, version").eq("id", data.id).single();
      if (saved.error) throw new Error(saved.error.message);
      return saved.data as { id: string; kind: string; version: number };
    };
    const out = await post(accountId, plan.out, "out");
    if (plan.into && targetId) {
      const into = await post(targetId, plan.into, "in");
      if (out.kind === "ordinary" && into.kind === "ordinary") {
        const linked = await supabase.rpc("link_transactions", { p_operation: "transfer", p_primary_id: plan.into.amountMinor > 0n ? out.id : into.id, p_expected_version: plan.into.amountMinor > 0n ? out.version : into.version,
          p_other_id: plan.into.amountMinor > 0n ? into.id : out.id, p_other_version: plan.into.amountMinor > 0n ? into.version : out.version, p_fx_rate_id: null, p_fees: [], p_request_id: stableId(`${requestId}:link`) });
        if (linked.error) throw new Error(linked.error.message);
      }
    }
    const fresh = await supabase.from("accounts").select("version").eq("id", accountId).single();
    if (fresh.error) throw new Error(fresh.error.message);
    const { error } = await supabase.rpc("edit_money_metadata", { p_entity_type: "account", p_id: accountId, p_expected_version: fresh.data.version, p_patch: { archived: true }, p_request_id: stableId(`${requestId}:archive`) });
    if (error) throw new Error(error.message);
  } catch (error) {
    return { error: error instanceof z.ZodError ? "Choose what happened to the money" : error instanceof Error ? error.message : "Could not archive this account" };
  }
  revalidatePath("/", "layout");
  redirect(`/money/accounts?saved=account:${accountId}#account-${accountId}`);
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
  redirect(`/money/accounts?saved=balance:${String(form.get("accountId"))}#account-${String(form.get("accountId"))}`);
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

export async function addAccountSafely(_state: SafeState, form: FormData) { return safely(form, addAccount); }
export async function addOwnAccountSafely(_state: SafeState, form: FormData) { return safely(form, addOwnAccount); }
export async function undoMoneyMetadataSafely(_state: SafeState, form: FormData) { return safely(form, undoMoneyMetadata); }
export async function undoBalanceSafely(_state: SafeState, form: FormData) { return safely(form, undoBalance); }
export async function removeOwnAccountSafely(_state: SafeState, form: FormData) { return safely(form, removeOwnAccount); }
export async function findTransfersSafely(_state: SafeState, form: FormData) { return safely(form, findTransfersBetweenOwnAccounts); }
