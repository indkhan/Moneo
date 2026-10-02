"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { minorDigits } from "@/lib/finance/fx";

function parseCurrency(raw: unknown): string {
  const normalized = String(raw ?? "").trim().toUpperCase();
  const code = z.string().regex(/^[A-Z]{3}$/).parse(normalized);
  minorDigits(code);
  return code;
}

function parseRateText(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (text.length > 40) throw new Error("Rate is too long");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Invalid rate: ${text}`);
  if (BigInt(`${match[1]}${match[2] ?? ""}`) <= 0n) throw new Error("Rate must be positive");
  return text;
}

export async function setDisplayCurrency(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const currency = parseCurrency(form.get("currency"));
  // Display-only: original transactions, accounts and balances are never mutated.
  const { error } = await supabase.from("workspaces").update({ display_currency: currency }).eq("id", workspace.id);
  if (error) throw error;
  redirect("/plan/currency");
}

export async function addFxRate(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const from = parseCurrency(form.get("from"));
  const to = parseCurrency(form.get("to"));
  if (from === to) throw new Error("Rate pair must be two different currencies");
  const rateText = parseRateText(form.get("rate"));
  const rateDate = z.iso.date().parse(form.get("rateDate"));
  if (rateDate > calendarDate(new Date(), workspace.timezone)) throw new Error("Rate date cannot be in the future");
  const sourceRaw = String(form.get("source") ?? "manual").trim() || "manual";
  const source = z.string().trim().min(1).max(120).parse(sourceRaw);
  // Manual dated rate only; never rewrites original financial records.
  const { error } = await supabase.from("fx_rates").insert({
    workspace_id: workspace.id,
    from_currency: from,
    to_currency: to,
    rate_text: rateText,
    rate_date: rateDate,
    source,
  });
  if (error && error.code === "23505") throw new Error("A rate for this pair and date already exists");
  if (error) throw error;
  redirect("/plan/currency");
}
