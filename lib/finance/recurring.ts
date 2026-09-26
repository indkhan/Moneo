// Pure recurring-pattern detector over posted transactions. No DB access, no writes.
export type RecurringTransaction = {
  id: string;
  /** YYYY-MM-DD posted date. */
  date: string;
  description: string;
  /** Signed minor units; sign splits series (income vs spending never merge). */
  amountMinor: bigint;
  currencyCode: string;
  accountId: string;
};

export type RecurringSeries = {
  cadence: "weekly" | "monthly";
  /** Estimated label taken from the most common raw description in the series. */
  label: string;
  accountId: string;
  currencyCode: string;
  amountMinMinor: bigint;
  amountMaxMinor: bigint;
  /** Evidence transaction IDs, oldest first. */
  transactionIds: string[];
  occurrences: number;
  /** Heuristic 0..1; higher means tighter gaps and amounts plus more occurrences. */
  confidence: number;
};

const MAX_TRANSACTIONS = 10_000;
const WEEKLY_MIN = 5;
const WEEKLY_MAX = 9;
const MONTHLY_MIN = 25;
const MONTHLY_MAX = 35;
// Amounts within a series must agree to 15% of the largest absolute amount.
const AMOUNT_TOLERANCE_PERCENT = 15n;

function parseDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw new Error(`Invalid date: ${date}`);
  return timestamp;
}

function normalizeDescription(description: string): string {
  return description.toLowerCase().replace(/\s+/g, " ").trim();
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function detectRecurring(transactions: RecurringTransaction[]): RecurringSeries[] {
  if (transactions.length > MAX_TRANSACTIONS) throw new Error(`Too many transactions: ${transactions.length}`);
  const groups = new Map<string, RecurringTransaction[]>();
  for (const transaction of transactions) {
    parseDate(transaction.date);
    const sign = transaction.amountMinor < 0n ? "-" : transaction.amountMinor > 0n ? "+" : "0";
    const key = [transaction.accountId, transaction.currencyCode, sign, normalizeDescription(transaction.description)].join("\u0000");
    const group = groups.get(key);
    if (group) group.push(transaction);
    else groups.set(key, [transaction]);
  }
  const series: RecurringSeries[] = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const ordered = [...group].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    const gaps = ordered.slice(1).map((item, index) =>
      Math.round((parseDate(item.date) - parseDate(ordered[index].date)) / 86400000));
    // ponytail: fixed 5-9/25-35 day gap windows plus exact normalized-description match; misses drifting dates, fuzzy merchant names, and biweekly/quarterly cadences — add median-gap clustering plus name similarity when that matters.
    const cadence =
      gaps.every((gap) => gap >= WEEKLY_MIN && gap <= WEEKLY_MAX) ? ("weekly" as const)
      : gaps.every((gap) => gap >= MONTHLY_MIN && gap <= MONTHLY_MAX) ? ("monthly" as const)
      : null;
    if (!cadence) continue;
    let min = ordered[0].amountMinor;
    let max = ordered[0].amountMinor;
    for (const item of ordered) {
      if (item.amountMinor < min) min = item.amountMinor;
      if (item.amountMinor > max) max = item.amountMinor;
    }
    const biggest = abs(max) > abs(min) ? abs(max) : abs(min);
    if (biggest === 0n ? min !== max : (abs(max - min) * 100n > biggest * AMOUNT_TOLERANCE_PERCENT)) continue;
    const counts = new Map<string, number>();
    for (const item of ordered) counts.set(item.description.trim(), (counts.get(item.description.trim()) ?? 0) + 1);
    let label = ordered[0].description.trim();
    let best = 0;
    for (const [candidate, count] of counts) {
      if (count > best || (count === best && candidate < label)) {
        label = candidate;
        best = count;
      }
    }
    const exactAmounts = min === max;
    const confidence = Math.min(0.95, Math.round((0.6 + 0.05 * (ordered.length - 3) + (exactAmounts ? 0.1 : 0)) * 100) / 100);
    series.push({
      cadence,
      label,
      accountId: ordered[0].accountId,
      currencyCode: ordered[0].currencyCode,
      amountMinMinor: min,
      amountMaxMinor: max,
      transactionIds: ordered.map((item) => item.id),
      occurrences: ordered.length,
      confidence,
    });
  }
  series.sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1
    : a.currencyCode < b.currencyCode ? -1 : a.currencyCode > b.currencyCode ? 1
    : a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  return series;
}
