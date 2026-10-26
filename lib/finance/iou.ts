import { z } from "zod";

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
