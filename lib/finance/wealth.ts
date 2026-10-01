import { minorDigits } from "./fx";
import type { SupabaseClient } from "@supabase/supabase-js";

export function decimalRatio(value: string) {
  const match = /^(\d{1,24})(?:\.(\d{1,18}))?$/.exec(value.trim());
  if (!match) throw new Error("Use a nonnegative decimal with a dot and no grouping");
  return { numerator: BigInt(match[1] + (match[2] ?? "")), denominator: 10n ** BigInt(match[2]?.length ?? 0) };
}
function rounded(numerator: bigint, denominator: bigint) { return (numerator * 2n + denominator) / (denominator * 2n); }

export function holdingValue(quantity: string, unitPrice: string, currency: string): bigint {
  const q = decimalRatio(quantity); const p = decimalRatio(unitPrice);
  if (q.numerator === 0n) throw new Error("Quantity must be positive");
  const value = rounded(q.numerator * p.numerator * 10n ** BigInt(minorDigits(currency)), q.denominator * p.denominator);
  if (value > 9223372036854775807n) throw new Error("Value exceeds supported integer range");
  return value;
}
export function wealthAmount(value: string, currency: string) {
  const negative = value.trim().startsWith("-");
  const ratio = decimalRatio(negative ? value.trim().slice(1) : value);
  const scale = 10n ** BigInt(minorDigits(currency));
  if (ratio.denominator > scale) throw new Error("Amount has too many decimal places for this currency");
  const amount = ratio.numerator * scale / ratio.denominator * (negative ? -1n : 1n);
  if (amount < -9223372036854775808n || amount > 9223372036854775807n) throw new Error("Amount exceeds supported integer range");
  return amount;
}
function dateValue(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Invalid calendar date");
  return date;
}
export function debtPayments(input: { principalMinor: bigint; annualRate: string; monthlyPaymentMinor: bigint; nextPaymentOn: string }, start: string, days: number) {
  const rate = decimalRatio(input.annualRate);
  if (rate.numerator > 1000n * rate.denominator || input.principalMinor > 0n || input.monthlyPaymentMinor <= 0n || !Number.isInteger(days) || days < 1 || days > 365) throw new Error("Invalid debt assumptions");
  const first = dateValue(input.nextPaymentOn); const from = dateValue(start); const end = from.getTime() + days * 86400000;
  if (first < from) throw new Error("Update the outstanding principal and next payment date before forecasting");
  let outstanding = -input.principalMinor;
  const result: { date: string; paymentMinor: bigint; interestMinor: bigint; principalMinor: bigint; remainingMinor: bigint }[] = [];
  for (let month = 0; month < 13 && outstanding > 0n; month++) {
    const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + month, 1));
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(first.getUTCDate(), last));
    if (date.getTime() >= end) break;
    const interestMinor = rounded(outstanding * rate.numerator, rate.denominator * 1200n);
    const due = outstanding + interestMinor;
    const paymentMinor = due < input.monthlyPaymentMinor ? due : input.monthlyPaymentMinor;
    const principalMinor = paymentMinor - interestMinor;
    outstanding = due - paymentMinor;
    result.push({ date: date.toISOString().slice(0, 10), paymentMinor, interestMinor, principalMinor, remainingMinor: outstanding });
  }
  return result;
}

export type WealthValue = { id: string; name: string; amount_minor: string; currency_code: string; as_of: string; linked_account_id: string | null };
export function wealthEvidence(rows: WealthValue[], today: string) {
  dateValue(today);
  const included: { id: string; name: string; amountMinor: bigint; currencyCode: string; asOf: string; provenance: string }[] = [];
  const excludedLinked: string[] = []; const missingInputs: string[] = [];
  for (const row of rows) {
    if (row.linked_account_id) { excludedLinked.push(row.id); continue; }
    dateValue(row.as_of);
    if (row.as_of !== today) { missingInputs.push(`valuation:${row.id}:${row.as_of > today ? "future" : "historical"}`); continue; }
    if (typeof row.amount_minor !== "string" || !/^-?\d+$/.test(row.amount_minor)) throw new Error("Invalid wealth money");
    minorDigits(row.currency_code);
    included.push({ id: row.id, name: row.name, amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code, asOf: row.as_of, provenance: "manual valuation" });
  }
  return { included, excludedLinked, missingInputs };
}

export type WealthItem = WealthValue & { kind: "holding" | "asset" | "debt"; quantity_text: string | null; unit_price_text: string | null; cost_basis_minor: string | null;
  payment_account_id: string | null; annual_rate_text: string | null; monthly_payment_minor: string | null; next_payment_on: string | null;
  payment_assumption_id: string | null; payment_transaction_id: string | null; version: number; removed_at: string | null };

export async function loadWealthItems(client: SupabaseClient, workspaceId: string, includeRemoved = false): Promise<WealthItem[]> {
  const rows: WealthItem[] = [];
  for (let offset = 0; ; offset += 500) {
    let query = client.from("wealth_items").select("id, name, kind, currency_code, amount_minor::text, quantity_text, unit_price_text, cost_basis_minor::text, as_of, linked_account_id, payment_account_id, annual_rate_text, monthly_payment_minor::text, next_payment_on, payment_assumption_id, payment_transaction_id, version, removed_at")
      .eq("workspace_id", workspaceId).order("created_at").order("id");
    if (!includeRemoved) query = query.is("removed_at", null);
    const result = await query.range(offset, offset + 499);
    if (result.error) throw result.error;
    rows.push(...result.data as WealthItem[]);
    if (!result.data || result.data.length < 500) return rows;
  }
}

export function buildDebtForecast(items: WealthItem[], accounts: { id: string; type?: string; currency_code: string }[], ledger: { id: string; account_id: string; amount_minor: string | number; currency_code: string; posted_on: string; status: string }[], assumptions: { id: string; account_id: string | null; amount_minor: string; currency_code: string; cadence: string; starts_on: string; ends_on: string | null }[], today: string, days: number): { events: { date: string; accountId: string; currencyCode: string; amountMinor: bigint }[]; excludedAssumptionIds: string[]; missingInputs: string[] } {
  const minor = (value: string | number) => { if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Unsafe debt ledger money"); return BigInt(value); };
  const events: { date: string; accountId: string; currencyCode: string; amountMinor: bigint }[] = [];
  const excludedAssumptionIds: string[] = []; const missingInputs: string[] = []; const provenance = new Set<string>();
  for (const item of items.filter(item => item.kind === "debt" && !item.removed_at)) {
    const missing = (reason: string) => missingInputs.push(`debt:${item.id}:${reason}`);
    if (BigInt(item.amount_minor) === 0n) continue;
    if (item.as_of !== today) { missing("principal valuation is historical"); continue; }
    const account = accounts.find(account => account.id === item.payment_account_id);
    if (!account || !["checking", "savings", "cash", "wallet"].includes(account.type ?? "") || account.currency_code !== item.currency_code) { missing("liquid repayment account"); continue; }
    if (!item.next_payment_on || !item.annual_rate_text || BigInt(item.monthly_payment_minor ?? "0") <= 0n) { missing("repayment assumptions"); continue; }
    const keys = [item.payment_assumption_id ? `assumption:${item.payment_assumption_id}` : null, item.payment_transaction_id ? `pending:${item.payment_transaction_id}` : null].filter((key): key is string => key !== null);
    if (keys.some(key => provenance.has(key))) { missing("duplicate repayment provenance"); continue; }
    keys.forEach(key => provenance.add(key));
    if (item.payment_assumption_id) {
      const assumption = assumptions.find(assumption => assumption.id === item.payment_assumption_id);
      if (!assumption || assumption.account_id !== account.id || assumption.currency_code !== item.currency_code || assumption.amount_minor !== `-${item.monthly_payment_minor}` || assumption.cadence !== "monthly" || assumption.starts_on !== item.next_payment_on || assumption.ends_on !== null) {
        missing("repayment association changed"); continue;
      }
    }
    let payments: ReturnType<typeof debtPayments>;
    try { payments = debtPayments({ principalMinor: BigInt(item.amount_minor), annualRate: item.annual_rate_text, monthlyPaymentMinor: BigInt(item.monthly_payment_minor!), nextPaymentOn: item.next_payment_on }, today, days); }
    catch { missing("repayment assumptions need update"); continue; }
    const pending = item.payment_transaction_id ? ledger.find(row => row.id === item.payment_transaction_id) : undefined;
    if (item.payment_transaction_id && (!pending || pending.account_id !== account.id || pending.currency_code !== item.currency_code || pending.status !== "pending" || pending.posted_on !== item.next_payment_on || minor(pending.amount_minor) !== -BigInt(item.monthly_payment_minor!))) {
      missing("pending repayment association changed"); continue;
    }
    if (pending && payments[0] && minor(pending.amount_minor) !== -payments[0].paymentMinor) { missing("pending repayment differs from final payoff"); continue; }
    const itemEvents: typeof events = [];
    const missingBeforePayments = missingInputs.length;
    for (const payment of payments) {
      // Current booked balances already deduct these dated pending holds in evaluatePlan.
      const matchingHolds = payment.date <= today ? ledger.filter(row => row.account_id === account.id && row.currency_code === item.currency_code && row.status === "pending" && row.posted_on === payment.date && minor(row.amount_minor) === -payment.paymentMinor) : [];
      if (matchingHolds.length) {
        if (matchingHolds.length !== 1 || matchingHolds[0].id !== item.payment_transaction_id) missing("pending repayment needs association");
        continue;
      }
      itemEvents.push({ date: payment.date, accountId: account.id, currencyCode: item.currency_code, amountMinor: -payment.paymentMinor });
    }
    // Retain an existing confirmed obligation when its proposed replacement is invalid.
    if (missingInputs.length === missingBeforePayments) {
      if (item.payment_assumption_id) excludedAssumptionIds.push(item.payment_assumption_id);
      events.push(...itemEvents);
    }
  }
  return { events, excludedAssumptionIds, missingInputs };
}
