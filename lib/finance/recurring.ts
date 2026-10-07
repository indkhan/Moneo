import { recurringCadences } from "./cadences";

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
  /** Owned merchant identity when recorded; reference text is only a fallback. */
  merchantId?: string | null;
};

export type RecurringSeries = {
  cadence: typeof recurringCadences[number];
  /** Estimated label taken from the most common raw description in the series. */
  label: string;
  accountId: string;
  currencyCode: string;
  amountMinMinor: bigint;
  amountMaxMinor: bigint;
  /** Evidence transaction IDs, oldest first. */
  transactionIds: string[];
  occurrences: number;
  /** Uncalibrated heuristic score; more evidence, exact amounts and fewer unobserved slots increase it. */
  confidence: number;
  /** Observed gaps do not establish whether an unobserved payment occurred. */
  missingPeriods: number;
  anchorDate: string;
  runAnchorId: string;
  observedOccurrences: number;
  evidenceLimited: boolean;
  sameDateAlternatives: number;
};

const MAX_TRANSACTIONS = 10_000;
// Amounts within a series must agree to 15% of the largest absolute amount.
const AMOUNT_TOLERANCE_PERCENT = 15n;

function parseDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw new Error(`Invalid date: ${date}`);
  return timestamp;
}

function normalizeDescription(description: string): string {
  return description.toLowerCase().replace(/\b(?:invoice|reference|ref)[\s:#-]+[a-z0-9-]+\b/g, " ").replace(/\s+/g, " ").trim();
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function amountFits(min: bigint, max: bigint) {
  const largest = abs(max) > abs(min) ? abs(max) : abs(min);
  return largest === 0n ? min === max : abs(max - min) * 100n <= largest * AMOUNT_TOLERANCE_PERCENT;
}

const cadences: {cadence: RecurringSeries["cadence"]; days?: number; months?: number; tolerance: number}[] = [
  {cadence: "weekly", days: 7, tolerance: 2}, {cadence: "biweekly", days: 14, tolerance: 2},
  {cadence: "monthly", months: 1, tolerance: 4}, {cadence: "quarterly", months: 3, tolerance: 4},
  {cadence: "yearly", months: 12, tolerance: 7},
];

export function recurringDateTolerance(cadence: string): number {
  return cadences.find(item => item.cadence === cadence)?.tolerance ?? 0;
}

type ParsedDate = {timestamp: number; year: number; month: number; day: number};
function occurrenceIndex(anchor: ParsedDate, observed: ParsedDate, cadence: typeof cadences[number], expectedDates: Map<number, number>) {
  if (cadence.days) {
    const index = Math.round((observed.timestamp - anchor.timestamp) / (cadence.days * 86400000));
    return {index, difference: Math.abs(observed.timestamp - anchor.timestamp - index * cadence.days * 86400000) / 86400000};
  }
  const distance = (observed.year - anchor.year) * 12 + observed.month - anchor.month;
  let closest = {index: -1, difference: Infinity};
  const approximate = Math.floor(distance / cadence.months!);
  for (const index of [approximate - 1, approximate, approximate + 1]) {
    if (index < 0) continue;
    let expected = expectedDates.get(index);
    if (expected === undefined) {
      const month = anchor.year * 12 + anchor.month + index * cadence.months!;
      const day = new Date(0);
      day.setUTCFullYear(Math.floor(month / 12), month % 12 + 1, 0);
      day.setUTCDate(Math.min(anchor.day, day.getUTCDate()));
      expected = day.getTime(); expectedDates.set(index, expected);
    }
    const difference = Math.abs(observed.timestamp - expected) / 86400000;
    if (difference < closest.difference) closest = {index, difference};
  }
  return closest;
}

export function detectRecurring(transactions: RecurringTransaction[]): RecurringSeries[] {
  if (transactions.length > MAX_TRANSACTIONS) throw new Error(`Too many transactions: ${transactions.length}`);
  const groups = new Map<string, RecurringTransaction[]>();
  const dates = new Map<string, ParsedDate>();
  for (const transaction of transactions) {
    if (!dates.has(transaction.date)) {
      const timestamp = parseDate(transaction.date), date = new Date(timestamp);
      dates.set(transaction.date, {timestamp, year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate()});
    }
    if (transaction.amountMinor === 0n) continue;
    const sign = transaction.amountMinor < 0n ? "-" : transaction.amountMinor > 0n ? "+" : "0";
    const identity = transaction.merchantId ? `merchant:${transaction.merchantId}` : `description:${normalizeDescription(transaction.description)}`;
    const key = [transaction.accountId, transaction.currencyCode, sign, identity].join("\u0000");
    const group = groups.get(key);
    if (group) group.push(transaction);
    else groups.set(key, [transaction]);
  }
  const series: RecurringSeries[] = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const candidates: {rows: RecurringTransaction[]; cadence: RecurringSeries["cadence"]; missing: number; difference: number}[] = [];
    const byDateAmount = new Map<string, RecurringTransaction>();
    // Equal-date/equal-amount observations cannot establish distinct schedules.
    // Preserve materially different same-date amounts and disclose selected alternatives.
    for (const row of [...group].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
      const key = `${row.date}\0${row.amountMinor}`;
      if (!byDateAmount.has(key)) byDateAmount.set(key, row);
    }
    const sorted = [...byDateAmount.values()];
    for (const cadence of cadences) {
      const used = new Set<string>();
      for (let start = 0; start < sorted.length - 2; start++) {
        if (used.has(sorted[start].id)) continue;
        const rows = [sorted[start]];
        const expectedDates = new Map<number, number>();
        let previous = 0, missing = 0, difference = 0;
        let min = sorted[start].amountMinor, max = min;
        for (let next = start + 1; next < sorted.length; next++) {
          if (used.has(sorted[next].id)) continue;
          const occurrence = occurrenceIndex(dates.get(sorted[start].date)!, dates.get(sorted[next].date)!, cadence, expectedDates);
          // ponytail: at most two unobserved periods per gap; longer gaps start another candidate run.
          if (occurrence.index - previous > 3) break;
          if (occurrence.index <= previous || occurrence.difference > cadence.tolerance) continue;
          const nextMin = sorted[next].amountMinor < min ? sorted[next].amountMinor : min;
          const nextMax = sorted[next].amountMinor > max ? sorted[next].amountMinor : max;
          if (!amountFits(nextMin, nextMax)) continue;
          min = nextMin; max = nextMax;
          missing += occurrence.index - previous - 1; previous = occurrence.index;
          difference += occurrence.difference; rows.push(sorted[next]);
        }
        if (rows.length >= 3) {
          rows.forEach(row => used.add(row.id));
          candidates.push({rows, cadence: cadence.cadence, missing, difference});
        }
      }
    }
    candidates.sort((a, b) => b.rows.length - a.rows.length || a.missing - b.missing || a.difference - b.difference || a.cadence.localeCompare(b.cadence));
    const assigned = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.rows.some(row => assigned.has(row.id))) continue;
      const observed = candidate.rows;
      const ordered = observed.length > 1000 ? [observed[0], ...observed.slice(-999)] : observed; // Preserve the owned calendar anchor inside the RPC ceiling.
      const selectedDates = new Set(ordered.map(row => row.date));
      const sameDateAlternatives = group.filter(row => selectedDates.has(row.date) &&
        amountFits(row.amountMinor < ordered[0].amountMinor ? row.amountMinor : ordered[0].amountMinor,
          row.amountMinor > ordered[0].amountMinor ? row.amountMinor : ordered[0].amountMinor)).length - ordered.length;
      observed.forEach(row => assigned.add(row.id));
      let min = ordered[0].amountMinor;
      let max = ordered[0].amountMinor;
      for (const item of ordered) {
        if (item.amountMinor < min) min = item.amountMinor;
        if (item.amountMinor > max) max = item.amountMinor;
      }
      if (!amountFits(min, max)) continue;
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
      const confidence = Math.max(0.1, Math.min(0.95, Math.round((0.6 + 0.05 * (ordered.length - 3) + (exactAmounts ? 0.1 : 0) - 0.05 * candidate.missing) * 100) / 100));
      series.push({
        cadence: candidate.cadence,
        label,
        accountId: ordered[0].accountId,
        currencyCode: ordered[0].currencyCode,
        amountMinMinor: min,
        amountMaxMinor: max,
        transactionIds: ordered.map((item) => item.id),
        occurrences: ordered.length,
        confidence,
        missingPeriods: candidate.missing,
        anchorDate: observed[0].date,
        runAnchorId: observed[0].id,
        observedOccurrences: observed.length,
        evidenceLimited: observed.length > ordered.length,
        sameDateAlternatives,
    });
    }
  }
  series.sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1
    : a.currencyCode < b.currencyCode ? -1 : a.currencyCode > b.currencyCode ? 1
    : a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  return series;
}
