import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

// Money lent to or borrowed from a person lives in Wealth as an ordinary asset ("Lent to Sam")
// or debt ("Owed to Sam"), so net worth, history and Undo work unchanged. The name carries the person.
export type IouDirection = "lent" | "borrowed";
const prefixes = { lent: "Lent to ", borrowed: "Owed to " } as const;

export const iouCreateSchema = z.object({ direction: z.enum(["lent", "borrowed"]), person: z.string().trim().min(1).max(100),
  amountMinor: z.string().regex(/^[1-9]\d{0,17}$/), currencyCode: z.string().regex(/^[A-Z]{3}$/), date: z.iso.date() }).strict();
export const iouSettleSchema = z.object({ itemId: z.uuid(), transactionId: z.uuid(), appliedMinor: z.string().regex(/^[1-9]\d{0,17}$/) }).strict();

export const iouName = (direction: IouDirection, person: string) => `${prefixes[direction]}${person.trim()}`.slice(0, 120);
export function parseIouName(name: string): { direction: IouDirection; person: string } | null {
  for (const direction of ["lent", "borrowed"] as const) if (name.startsWith(prefixes[direction]) && name.length > prefixes[direction].length) return { direction, person: name.slice(prefixes[direction].length) };
  return null;
}

/** The wealth record a new IOU saves: a lent amount is an asset, a borrowed amount a zero-interest debt. */
export function iouRecord(input: z.infer<typeof iouCreateSchema>) {
  const lent = input.direction === "lent";
  return { kind: lent ? "asset" : "debt", name: iouName(input.direction, input.person), currency_code: input.currencyCode,
    amount_minor: `${lent ? "" : "-"}${input.amountMinor}`, as_of: input.date, quantity_text: null, unit_price_text: null, cost_basis_minor: null,
    linked_account_id: null, payment_account_id: null, annual_rate_text: lent ? null : "0", monthly_payment_minor: lent ? null : "0",
    next_payment_on: null, payment_assumption_id: null, payment_transaction_id: null };
}

export type IouItem = { id: string; kind: string; name: string; currency_code: string; amount_minor: string; as_of: string; version: number; removed_at: string | null; linked_account_id: string | null };
export type IouTransaction = { id: string; description: string; amount_minor: string; currency_code: string; posted_on: string };
export type RepaymentMatch = { itemId: string; transactionId: string; appliedMinor: string; person: string; direction: IouDirection; owedMinor: string };

const abs = (value: bigint) => value < 0n ? -value : value;
const normalize = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
function mentions(description: string, person: string) {
  const name = normalize(person).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${name}($|[^\\p{L}\\p{N}])`, "u").test(normalize(description));
}

export type LoanStart = { person: string; direction: IouDirection; amountMinor: bigint; currencyCode: string; date: string };
const dayGap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * The bank transaction that paid each IOU out (money lent leaves the account, money borrowed arrives): the exact amount
 * and currency, within 10 days of the IOU's date, naming the person (first name is enough). It is a loan, not spending,
 * so nothing should ask for its category or flag it as unusual.
 */
export function loanPayouts(loans: LoanStart[], transactions: IouTransaction[]) {
  const ids = new Set<string>();
  for (const loan of loans) {
    const signed = loan.direction === "lent" ? -loan.amountMinor : loan.amountMinor;
    const first = loan.person.trim().split(/\s+/)[0];
    const match = transactions.find(row => !ids.has(row.id) && row.currency_code === loan.currencyCode && BigInt(row.amount_minor) === signed
      && dayGap(row.posted_on, loan.date) <= 10 && (mentions(row.description, loan.person) || mentions(row.description, first)));
    if (match) ids.add(match.id);
  }
  return ids;
}

/**
 * Bank transactions that look like a repayment: they name the person, move money the right way
 * (in for money lent, out for money borrowed), match the currency and come on or after the IOU's date.
 * Each transaction goes to the open IOU whose remaining amount is closest; partial payments count.
 */
export function repaymentMatches(items: IouItem[], transactions: IouTransaction[]): RepaymentMatch[] {
  const open = items.flatMap(item => {
    const parsed = parseIouName(item.name);
    const owed = BigInt(item.amount_minor);
    const right = parsed && ((parsed.direction === "lent" && item.kind === "asset" && owed > 0n) || (parsed.direction === "borrowed" && item.kind === "debt" && owed < 0n));
    return right && !item.removed_at && !item.linked_account_id ? [{ item, ...parsed, owed: abs(owed) }] : [];
  });
  const matches: RepaymentMatch[] = [];
  for (const transaction of transactions) {
    const amount = BigInt(transaction.amount_minor);
    const candidates = open.filter(entry => entry.item.currency_code === transaction.currency_code && transaction.posted_on >= entry.item.as_of
      && (entry.direction === "lent" ? amount > 0n : amount < 0n) && mentions(transaction.description, entry.person));
    if (!candidates.length) continue;
    const gap = (owed: bigint) => abs(owed - abs(amount));
    const best = candidates.reduce((a, b) => gap(b.owed) < gap(a.owed) ? b : a);
    matches.push({ itemId: best.item.id, transactionId: transaction.id, person: best.person, direction: best.direction,
      owedMinor: best.owed.toString(), appliedMinor: (abs(amount) < best.owed ? abs(amount) : best.owed).toString() });
  }
  return matches;
}

/** The record after a repayment, or null when it settles the IOU in full (the item is then removed). */
export function settledRecord(item: IouItem & { annual_rate_text: string | null; monthly_payment_minor: string | null }, appliedMinor: string, today: string) {
  const lent = item.kind === "asset";
  const left = BigInt(item.amount_minor) + (lent ? -BigInt(appliedMinor) : BigInt(appliedMinor));
  if (lent ? left <= 0n : left >= 0n) return null;
  return { ...iouRecord({ direction: lent ? "lent" : "borrowed", person: parseIouName(item.name)!.person, amountMinor: abs(left).toString(), currencyCode: item.currency_code, date: today }),
    annual_rate_text: item.annual_rate_text, monthly_payment_minor: item.monthly_payment_minor };
}

/**
 * Ids of the bank transactions that paid out a recorded IOU (e.g. the transfer that lent Bilal €1,000) or repaid one. Each IOU is read as
 * first recorded in Wealth, so a later repayment or a full settlement does not lose its payout.
 */
export async function loadLoanPayoutIds(supabase: SupabaseClient, workspaceId: string): Promise<Set<string>> {
  const events = await supabase.from("wealth_events").select("item_id, after").eq("workspace_id", workspaceId).is("undone_at", null).order("created_at").limit(2000);
  if (events.error) throw new Error(events.error.message);
  const loans = new Map<string, LoanStart>();
  for (const { item_id, after } of (events.data ?? []) as { item_id: string; after: { name?: string; amount_minor?: string | number; currency_code?: string; as_of?: string } }[]) {
    const parsed = parseIouName(String(after?.name ?? ""));
    if (loans.has(item_id) || !parsed || after.amount_minor === undefined || !after.currency_code || !after.as_of) continue;
    const amount = BigInt(after.amount_minor);
    loans.set(item_id, { ...parsed, amountMinor: amount < 0n ? -amount : amount, currencyCode: after.currency_code, date: String(after.as_of).slice(0, 10) });
  }
  // Accepted repayments are loan money too.
  const settled = await supabase.from("agent_proposals").select("payload").eq("workspace_id", workspaceId).eq("kind", "iou_settle").eq("status", "accepted").limit(1000);
  if (settled.error) throw new Error(settled.error.message);
  const repaid = (settled.data ?? []).map(row => row.payload?.transactionId).filter((id): id is string => typeof id === "string");
  if (!loans.size) return new Set(repaid);
  const amounts = [...new Set([...loans.values()].map(loan => (loan.direction === "lent" ? -loan.amountMinor : loan.amountMinor).toString()))];
  const rows = await supabase.from("transactions").select("id, description, amount_minor::text, currency_code, posted_on").eq("workspace_id", workspaceId).neq("status", "voided")
    .in("amount_minor", amounts.slice(0, 200)).limit(2000);
  if (rows.error) throw new Error(rows.error.message);
  return new Set([...loanPayouts([...loans.values()], rows.data ?? []), ...repaid]);
}
