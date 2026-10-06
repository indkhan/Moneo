"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { parseManualAmount } from "@/app/money/transactions/input";
import { minorDigits } from "@/lib/finance/fx";
import { calendarDate, calendarDayBoundary } from "@/lib/finance/calendar";

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
  const { error } = await supabase.from("balance_snapshots").insert({ workspace_id: workspace.id,
    account_id: accountId, amount_minor: amount.toString(), currency_code: account.currency_code,
    as_of: asOf === today ? now.toISOString() : calendarDayBoundary(asOf, workspace.timezone), provenance: "manual" });
  if (error) throw error;
  redirect("/");
}
