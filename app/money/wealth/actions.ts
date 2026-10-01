"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { decimalRatio, holdingValue, wealthAmount } from "@/lib/finance/wealth";
import { minorDigits } from "@/lib/finance/fx";

const version = z.coerce.number().int().min(0).max(2147483646);
const optionalId = (form: FormData, key: string) => form.get(key) ? z.uuid().parse(form.get(key)) : null;

export async function saveWealthItem(form: FormData) {
  const { supabase } = await requireWorkspace();
  const kind = z.enum(["holding", "asset", "debt"]).parse(form.get("kind"));
  const currency = z.string().regex(/^[A-Z]{3}$/).parse(form.get("currency")); minorDigits(currency);
  const quantity = kind === "holding" ? z.string().trim().max(43).parse(form.get("quantity")) : null;
  const price = kind === "holding" ? z.string().trim().max(43).parse(form.get("unitPrice")) : null;
  const amount = kind === "holding" ? holdingValue(quantity!, price!, currency) : wealthAmount(z.string().parse(form.get("amount")), currency);
  if ((kind === "debt" && amount > 0n) || (kind !== "debt" && amount < 0n)) throw new Error("Debt principal must be negative; asset values must be nonnegative");
  const rate = kind === "debt" ? z.string().trim().max(43).parse(form.get("annualRate")) : null;
  if (rate) { const ratio = decimalRatio(rate); if (ratio.numerator > 1000n * ratio.denominator) throw new Error("Annual rate exceeds supported range"); }
  const payment = kind === "debt" ? wealthAmount(z.string().parse(form.get("monthlyPayment")), currency) : null;
  if (payment !== null && payment < 0n) throw new Error("Monthly payment must be nonnegative");
  if (!form.get("linkedAccountId") && form.get("standaloneConfirmed") !== "on") throw new Error("Confirm this value is not already included in an account balance");
  const record = { kind, name: z.string().trim().min(1).max(120).parse(form.get("name")), currency_code: currency, amount_minor: amount.toString(),
    quantity_text: quantity, unit_price_text: price, cost_basis_minor: kind !== "debt" && form.get("costBasis") ? wealthAmount(z.string().parse(form.get("costBasis")), currency).toString() : null,
    as_of: z.iso.date().parse(form.get("asOf")), linked_account_id: optionalId(form, "linkedAccountId"), payment_account_id: kind === "debt" ? optionalId(form, "paymentAccountId") : null,
    annual_rate_text: rate, monthly_payment_minor: payment?.toString() ?? null, next_payment_on: kind === "debt" && form.get("nextPaymentOn") ? z.iso.date().parse(form.get("nextPaymentOn")) : null,
    payment_assumption_id: kind === "debt" ? optionalId(form, "paymentAssumptionId") : null, payment_transaction_id: kind === "debt" ? optionalId(form, "paymentTransactionId") : null };
  const { error } = await supabase.rpc("edit_wealth_item", { p_id: z.uuid().parse(form.get("id")), p_expected_version: version.parse(form.get("version")), p_record: record, p_remove: false, p_request_id: z.uuid().parse(form.get("requestId")) });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout"); redirect("/money/wealth");
}

export async function removeWealthItem(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("edit_wealth_item", { p_id: z.uuid().parse(form.get("id")), p_expected_version: version.parse(form.get("version")), p_record: {}, p_remove: true, p_request_id: z.uuid().parse(form.get("requestId")) });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout"); redirect("/money/wealth");
}

export async function undoWealthEvent(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_wealth_event", { p_event_id: z.uuid().parse(form.get("eventId")), p_expected_version: version.parse(form.get("version")) });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout"); redirect("/money/wealth");
}
