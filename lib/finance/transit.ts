
export const TRANSIT_MATCH_DAYS = 3;
const FOREVER = "9999-12-31";

export type BrokerTransfer = { provider_id: string; type: string; amount_minor: string; currency_code: string; on_date: string; occurred_at: string; status: string; is_cancellation?: boolean; returns_provider_id: string | null; description?: string | null };
export type BankLeg = { id: string; accountId: string; amountMinor: bigint; currencyCode: string; postedOn: string; transferId: string | null; provesBroker: boolean; ownAccount: boolean; text?: string };
export type TransitWindow = { from: string; to: string; amountMinor: bigint; currencyCode: string; kind: "returned" | "matched" | "linked"; broker: boolean; accounts: string[]; key: string };
export type UnresolvedTransfer = { key: string; side: "broker" | "bank"; date: string; amountMinor: bigint; currencyCode: string; reason: "missing" | "ambiguous"; label: string };

const gap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
const abs = (value: bigint) => value < 0n ? -value : value;
const settled = (transfer: BrokerTransfer) => transfer.status === "SETTLED" && !transfer.is_cancellation;

function window(first: { date: string; signed: bigint }, second: { date: string }, amount: bigint, rest: Omit<TransitWindow, "from" | "to" | "amountMinor">): TransitWindow | null {
  if (first.date === second.date) return null;
  const [early, late] = first.date < second.date ? [first, second] : [second as typeof first, first];
  const sign = (first.date < second.date ? first.signed : -first.signed) > 0n ? -1n : 1n;
  return { from: early.date, to: late.date, amountMinor: sign * amount, ...rest };
}

export function brokerShownOn(transfer: Pick<BrokerTransfer, "on_date" | "occurred_at">, firstReal: string | null, reads: { as_of: string; created_at: string }[]) {
  if (firstReal && transfer.on_date < firstReal) return transfer.on_date;
  const occurred = Date.parse(transfer.occurred_at);
  return reads.filter(read => read.as_of >= transfer.on_date && Date.parse(read.created_at) >= occurred).map(read => read.as_of).sort()[0] ?? null;
}

export function matchTransfers({ transfers, legs, firstReal, reads, complete, coveredFrom }: {
  transfers: BrokerTransfer[]; legs: BankLeg[]; firstReal: string | null; reads: { as_of: string; created_at: string }[];
  complete: boolean;
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
    if (!other || leg.id > other.id || leg.currencyCode !== other.currencyCode || (leg.amountMinor < 0n) === (other.amountMinor < 0n)) continue;
    const amount = abs(leg.amountMinor) < abs(other.amountMinor) ? abs(leg.amountMinor) : abs(other.amountMinor);
    const made = window({ date: leg.postedOn, signed: leg.amountMinor }, { date: other.postedOn }, amount, { currencyCode: leg.currencyCode, kind: "linked", broker: false, accounts: [leg.accountId, other.accountId], key: `linked:${leg.id}` });
    if (made) windows.push(made);
  }
  return { windows, unresolved: unresolved.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key)) };
}

export function transitOn(windows: TransitWindow[], date: string, shows: (window: TransitWindow) => boolean = () => true) {
  const total = new Map<string, bigint>();
  for (const item of windows) if (item.from <= date && date < item.to && shows(item)) total.set(item.currencyCode, (total.get(item.currencyCode) ?? 0n) + item.amountMinor);
  return total;
}
