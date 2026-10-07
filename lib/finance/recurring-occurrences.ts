import type { BalanceTransaction } from "./balances";
import { calendarDate } from "./calendar";
export type OccurrencePosting = BalanceTransaction & { kind?: string; review_reasons?: string[] };
export type SettlementReceipt = { account_id: string; amount_minor: string; currency_code: string; kind: string; review_reasons: string[] };
export type OccurrenceSettlement = { id: string; assumption_id: string; scheduled_on: string; transaction_id: string; completes_occurrence: boolean; receipt: SettlementReceipt; undone_at: string | null; version?: number };

type Obligation = { id: string; account_id: string | null; amount_minor: string; currency_code: string };
// Status and booking date may change when a pending transaction settles; financial identity may not.
export function settlementReceipt(row: OccurrencePosting): SettlementReceipt {
  return { account_id: row.account_id, amount_minor: BigInt(row.canonical_amount_minor ?? row.amount_minor).toString(), currency_code: row.currency_code,
    kind: row.kind ?? "ordinary", review_reasons: [...(row.review_reasons ?? [])].sort() };
}
export function settlementPosting(item: Obligation, link: OccurrenceSettlement, ledger: OccurrencePosting[]) {
  const row = ledger.find(row => row.id === link.transaction_id);
  if (link.undone_at || !row || (row.status === "pending" && BigInt(row.pending_released_minor ?? "0") > 0n) || !["pending", "posted"].includes(row.status) || row.account_id !== item.account_id || row.currency_code !== item.currency_code ||
    row.kind !== "ordinary" || row.review_reasons?.length || JSON.stringify(settlementReceipt(row)) !== JSON.stringify(settlementReceipt({ ...row, ...link.receipt, canonical_amount_minor: link.receipt.amount_minor }))) return null;
  const amount = BigInt(row.canonical_amount_minor ?? row.amount_minor);
  return amount !== 0n && (amount < 0n) === (BigInt(item.amount_minor) < 0n) ? row : null;
}
export function reconcileOccurrence(item: Obligation, scheduledOn: string, settlements: OccurrenceSettlement[], ledger: OccurrencePosting[], asOf: string, startDate: string, timeZone = "Europe/Berlin") {
  const expected = BigInt(item.amount_minor);
  let fulfilled = 0n, complete = false;
  const events: { date: string; amountMinor: bigint; observed: boolean }[] = [];
  const seen = new Set<string>();
  for (const link of settlements) {
    if (link.undone_at || link.assumption_id !== item.id || link.scheduled_on !== scheduledOn) continue;
    const row = settlementPosting(item, link, ledger);
    if (!row || seen.has(row.id)) continue;
    const amount = BigInt(row.canonical_amount_minor ?? row.amount_minor);
    seen.add(row.id);
    fulfilled += amount;
    complete ||= link.completes_occurrence;
    // A current resolved opening includes posted evidence through asOf. Negative pending holds are
    // deducted separately; positive pending income remains a projected movement, never opening cash.
    const postingDate = row.status === "posted" && row.posted_at ? calendarDate(row.posted_at, timeZone) : row.posted_on;
    const alreadyReflected = row.status === "pending" ? amount < 0n && row.posted_on <= startDate :
      postingDate <= startDate && (!row.posted_at || Date.parse(row.posted_at) <= Date.parse(asOf));
    if (!alreadyReflected) events.push({ date: postingDate > startDate ? postingDate : startDate, amountMinor: BigInt(row.amount_minor), observed: true });
  }
  const remainder = expected - fulfilled;
  if (!complete && remainder !== 0n && (remainder < 0n) === (expected < 0n))
    events.push({ date: scheduledOn < startDate ? startDate : scheduledOn, amountMinor: remainder, observed: false });
  return events;
}
