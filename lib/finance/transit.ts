// Money moving between the owner's own accounts is one amount, even while its two sides land on different days. This works out,
// at read time, which days count it twice or not at all, and how much to add back on those days. No record is rewritten:
// new statements simply change the answer the next time it is read, and earlier days correct themselves.

export const TRANSIT_MATCH_DAYS = 3;
const FOREVER = "9999-12-31";

export type BrokerTransfer = { provider_id: string; type: string; amount_minor: string; currency_code: string; on_date: string; occurred_at: string; status: string; is_cancellation?: boolean; returns_provider_id: string | null; description?: string | null };
/** A posted bank row that is an own transfer. `provesBroker`: its IBAN or wording says the other side is the broker. `ownAccount`: it names one of the owner's tracked accounts. */
export type BankLeg = { id: string; accountId: string; amountMinor: bigint; currencyCode: string; postedOn: string; transferId: string | null; provesBroker: boolean; ownAccount: boolean; text?: string };
/** On days from <= date < to, `amountMinor` is added. A broker side counts only on days the broker has a value. */
export type TransitWindow = { from: string; to: string; amountMinor: bigint; currencyCode: string; kind: "returned" | "matched" | "linked"; broker: boolean; accounts: string[]; key: string };
export type UnresolvedTransfer = { key: string; side: "broker" | "bank"; date: string; amountMinor: bigint; currencyCode: string; reason: "missing" | "ambiguous"; label: string };

const gap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
const abs = (value: bigint) => value < 0n ? -value : value;
const settled = (transfer: BrokerTransfer) => transfer.status === "SETTLED" && !transfer.is_cancellation;

/** Between two opposite sides, the first to land is what's wrong until the second does: its effect is taken off. */
function window(first: { date: string; signed: bigint }, second: { date: string }, amount: bigint, rest: Omit<TransitWindow, "from" | "to" | "amountMinor">): TransitWindow | null {
  if (first.date === second.date) return null;
  const [early, late] = first.date < second.date ? [first, second] : [second as typeof first, first];
  const sign = (first.date < second.date ? first.signed : -first.signed) > 0n ? -1n : 1n;
  return { from: early.date, to: late.date, amountMinor: sign * amount, ...rest };
}

/**
 * The day a broker transfer shows in the broker's value. Before the first real sync, the calculated history has it on its own date.
 * After that, it shows from the first sync read after it happened. Null means no read has seen it yet.
 */
export function brokerShownOn(transfer: Pick<BrokerTransfer, "on_date" | "occurred_at">, firstReal: string | null, reads: { as_of: string; created_at: string }[]) {
  if (firstReal && transfer.on_date < firstReal) return transfer.on_date;
  const occurred = Date.parse(transfer.occurred_at);
  return reads.filter(read => read.as_of >= transfer.on_date && Date.parse(read.created_at) >= occurred).map(read => read.as_of).sort()[0] ?? null;
}

/**
 * Pairs the two sides of every own transfer that can be proven, and lists the ones that can't. A pair needs opposite amounts, the same
 * currency, a bank row proven to be the broker's by IBAN or wording, and exactly one candidate each way within the window. A side is
 * never used twice. A returned withdrawal pairs with its return by Scalable's own ID, so it needs no bank row at all.
 */
export function matchTransfers({ transfers, legs, firstReal, reads, complete, coveredFrom }: {
  transfers: BrokerTransfer[]; legs: BankLeg[]; firstReal: string | null; reads: { as_of: string; created_at: string }[];
  /** The whole broker list has been read, so a bank row with no broker side really is missing one. */
  complete: boolean;
  /** The first day of bank data: older broker transfers can't have a bank side on record. */
  coveredFrom: string | null;
}) {
  const live = transfers.filter(settled);
  const shown = (transfer: BrokerTransfer) => brokerShownOn(transfer, firstReal, reads) ?? FOREVER;
  const windows: TransitWindow[] = [], unresolved: UnresolvedTransfer[] = [];
  const byId = new Map(live.map(transfer => [transfer.provider_id, transfer]));

  const returned = new Set<string>();
  for (const back of live) {
    const out = back.returns_provider_id ? byId.get(back.returns_provider_id) : undefined;
    if (!out) continue;
    returned.add(back.provider_id); returned.add(out.provider_id);
    const made = window({ date: shown(out), signed: BigInt(out.amount_minor) }, { date: shown(back) }, abs(BigInt(out.amount_minor)), { currencyCode: out.currency_code, kind: "returned", broker: true, accounts: [], key: `returned:${out.provider_id}` });
    if (made) windows.push(made);
  }

  const open = live.filter(transfer => !returned.has(transfer.provider_id));
  // Own-reference wording proves a row too: the note on the bank's row is the note Scalable shows on the deposit.
  const reference = (leg: BankLeg, transfer: BrokerTransfer) => { const note = transfer.description?.replace(/\s+/g, " ").trim().toLowerCase(); return !!note && note.length >= 8 && !!leg.text && leg.text.replace(/\s+/g, " ").toLowerCase().includes(note); };
  const fits = (leg: BankLeg, transfer: BrokerTransfer) => leg.amountMinor === -BigInt(transfer.amount_minor) && leg.currencyCode === transfer.currency_code && gap(leg.postedOn, transfer.on_date) <= TRANSIT_MATCH_DAYS && (leg.provesBroker || reference(leg, transfer));
  const unlinked = legs.filter(leg => !leg.transferId);
  const paired = new Set<string>(), seenBroker = new Set<string>();
  const legsFor = (transfer: BrokerTransfer) => unlinked.filter(leg => fits(leg, transfer));
  const transfersFor = (leg: BankLeg) => open.filter(transfer => fits(leg, transfer));
  const ambiguous = (transfer: BrokerTransfer) => legsFor(transfer).length > 1 || legsFor(transfer).some(leg => transfersFor(leg).length > 1);
  for (const transfer of open) {
    if (ambiguous(transfer) || !legsFor(transfer).length) continue;
    const leg = legsFor(transfer)[0];
    paired.add(leg.id); seenBroker.add(transfer.provider_id);
    const made = window({ date: shown(transfer), signed: BigInt(transfer.amount_minor) }, { date: leg.postedOn }, abs(leg.amountMinor), { currencyCode: leg.currencyCode, kind: "matched", broker: true, accounts: [leg.accountId], key: `matched:${transfer.provider_id}` });
    if (made) windows.push(made);
  }

  for (const transfer of open) {
    if (seenBroker.has(transfer.provider_id) || (coveredFrom && gap(transfer.on_date, coveredFrom) > TRANSIT_MATCH_DAYS && transfer.on_date < coveredFrom)) continue;
    unresolved.push({ key: `broker:${transfer.provider_id}`, side: "broker", date: transfer.on_date, amountMinor: BigInt(transfer.amount_minor), currencyCode: transfer.currency_code, reason: ambiguous(transfer) ? "ambiguous" : "missing",
      label: `Scalable ${transfer.type === "DEPOSIT" ? "deposit" : "withdrawal"}` });
  }
  for (const back of live) if (back.returns_provider_id && !byId.has(back.returns_provider_id))
    unresolved.push({ key: `broker:${back.provider_id}`, side: "broker", date: back.on_date, amountMinor: BigInt(back.amount_minor), currencyCode: back.currency_code, reason: "missing", label: "Scalable returned withdrawal" });
  if (complete) for (const leg of unlinked) {
    if (paired.has(leg.id) || (!leg.provesBroker && !leg.ownAccount)) continue;
    unresolved.push({ key: `bank:${leg.id}`, side: "bank", date: leg.postedOn, amountMinor: leg.amountMinor, currencyCode: leg.currencyCode, reason: transfersFor(leg).some(ambiguous) ? "ambiguous" : "missing", label: leg.text?.slice(0, 80) ?? "Own transfer" });
  }

  const legById = new Map(legs.map(leg => [leg.id, leg]));
  for (const leg of legs) {
    const other = leg.transferId ? legById.get(leg.transferId) : undefined;
    // Each linked pair once. Other currencies aren't comparable here, and an exact fee stays a real change on its own date.
    if (!other || leg.id > other.id || leg.currencyCode !== other.currencyCode || (leg.amountMinor < 0n) === (other.amountMinor < 0n)) continue;
    const amount = abs(leg.amountMinor) < abs(other.amountMinor) ? abs(leg.amountMinor) : abs(other.amountMinor);
    const made = window({ date: leg.postedOn, signed: leg.amountMinor }, { date: other.postedOn }, amount, { currencyCode: leg.currencyCode, kind: "linked", broker: false, accounts: [leg.accountId, other.accountId], key: `linked:${leg.id}` });
    if (made) windows.push(made);
  }
  return { windows, unresolved: unresolved.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key)) };
}

/** What to add on a date, per currency. `shows` says whether a window's sides have balances that day: a correction only applies to what's already counted. */
export function transitOn(windows: TransitWindow[], date: string, shows: (window: TransitWindow) => boolean = () => true) {
  const total = new Map<string, bigint>();
  for (const item of windows) if (item.from <= date && date < item.to && shows(item)) total.set(item.currencyCode, (total.get(item.currencyCode) ?? 0n) + item.amountMinor);
  return total;
}
