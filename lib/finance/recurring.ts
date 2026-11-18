import { recurringCadences } from "./cadences";

export type RecurringTransaction = {
  id: string;
  date: string;
  description: string;
  amountMinor: bigint;
  currencyCode: string;
  accountId: string;
  merchantId?: string | null;
};

export type RecurringSeries = {
  cadence: typeof recurringCadences[number];
  label: string;
  accountId: string;
  currencyCode: string;
  amountMinMinor: bigint;
  amountMaxMinor: bigint;
  transactionIds: string[];
  occurrences: number;
  confidence: number;
  missingPeriods: number;
  anchorDate: string;
  runAnchorId: string;
  observedOccurrences: number;
  evidenceLimited: boolean;
  sameDateAlternatives: number;
};

const MAX_TRANSACTIONS = 10_000;
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

type CadenceRule = {cadence: RecurringSeries["cadence"]; tolerance: number; minimum: number} & ({days: number} | {months: number});

const cadences: CadenceRule[] = [
  {cadence: "weekly", days: 7, tolerance: 2, minimum: 6}, {cadence: "biweekly", days: 14, tolerance: 2, minimum: 5},
  {cadence: "monthly", months: 1, tolerance: 4, minimum: 3}, {cadence: "quarterly", months: 3, tolerance: 4, minimum: 3},
  {cadence: "yearly", months: 12, tolerance: 7, minimum: 3},
];

export function recurringDateTolerance(cadence: string): number {
  return cadences.find(item => item.cadence === cadence)?.tolerance ?? 0;
}

type ParsedDate = {timestamp: number; year: number; month: number; day: number};
function occurrenceIndex(anchor: ParsedDate, observed: ParsedDate, cadence: CadenceRule, expectedDates: Map<number, number>) {
  if ("days" in cadence) {
    const index = Math.round((observed.timestamp - anchor.timestamp) / (cadence.days * 86400000));
    return {index, difference: Math.abs(observed.timestamp - anchor.timestamp - index * cadence.days * 86400000) / 86400000};
  }
  const distance = (observed.year - anchor.year) * 12 + observed.month - anchor.month;
  let closest = {index: -1, difference: Infinity};
  const approximate = Math.floor(distance / cadence.months);
  for (const index of [approximate - 1, approximate, approximate + 1]) {
    if (index < 0) continue;
    let expected = expectedDates.get(index);
    if (expected === undefined) {
      const month = anchor.year * 12 + anchor.month + index * cadence.months;
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
    const candidates: {rows: RecurringTransaction[]; cadence: RecurringSeries["cadence"]; minimum: number; missing: number; difference: number}[] = [];
    const byDateAmount = new Map<string, RecurringTransaction>();
    for (const row of [...group].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
      const key = `${row.date}\0${row.amountMinor}`;
      if (!byDateAmount.has(key)) byDateAmount.set(key, row);
    }
    const sorted = [...byDateAmount.values()];
    for (const cadence of cadences) {
      const used = new Set<string>();
      for (let start = 0; start <= sorted.length - cadence.minimum; start++) {
        const first = sorted[start];
        const firstDate = first && dates.get(first.date);
        if (!first || !firstDate || used.has(first.id)) continue;
        const rows = [first];
        const expectedDates = new Map<number, number>();
        let previous = 0, missing = 0, difference = 0;
        let min = first.amountMinor, max = min;
        for (let next = start + 1; next < sorted.length; next++) {
          const following = sorted[next];
          const followingDate = following && dates.get(following.date);
          if (!following || !followingDate || used.has(following.id)) continue;
          const occurrence = occurrenceIndex(firstDate, followingDate, cadence, expectedDates);
          if (occurrence.index - previous > 3) break;
          if (occurrence.index <= previous || occurrence.difference > cadence.tolerance) continue;
          const nextMin = following.amountMinor < min ? following.amountMinor : min;
          const nextMax = following.amountMinor > max ? following.amountMinor : max;
          if (!amountFits(nextMin, nextMax)) continue;
          min = nextMin; max = nextMax;
          missing += occurrence.index - previous - 1; previous = occurrence.index;
          difference += occurrence.difference; rows.push(following);
        }
        if (rows.length >= cadence.minimum && missing <= rows.length - cadence.minimum) {
          rows.forEach(row => used.add(row.id));
          candidates.push({rows, cadence: cadence.cadence, minimum: cadence.minimum, missing, difference});
        }
      }
    }
    candidates.sort((a, b) => b.rows.length - a.rows.length || a.missing - b.missing || a.difference - b.difference || a.cadence.localeCompare(b.cadence));
    const assigned = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.rows.some(row => assigned.has(row.id))) continue;
      const observed = candidate.rows;
      const ordered = observed.length > 1000 ? [...observed.slice(0, 1), ...observed.slice(-999)] : observed;
      const [anchor] = ordered;
      if (!anchor) continue;
      const selectedDates = new Set(ordered.map(row => row.date));
      const sameDateAlternatives = group.filter(row => selectedDates.has(row.date) &&
        amountFits(row.amountMinor < anchor.amountMinor ? row.amountMinor : anchor.amountMinor,
          row.amountMinor > anchor.amountMinor ? row.amountMinor : anchor.amountMinor)).length - ordered.length;
      observed.forEach(row => assigned.add(row.id));
      let min = anchor.amountMinor;
      let max = anchor.amountMinor;
      for (const item of ordered) {
        if (item.amountMinor < min) min = item.amountMinor;
        if (item.amountMinor > max) max = item.amountMinor;
      }
      if (!amountFits(min, max)) continue;
      const counts = new Map<string, number>();
      for (const item of ordered) counts.set(item.description.trim(), (counts.get(item.description.trim()) ?? 0) + 1);
      let label = anchor.description.trim();
      let best = 0;
      for (const [candidate, count] of counts) {
        if (count > best || (count === best && candidate < label)) {
          label = candidate;
          best = count;
        }
      }
      const exactAmounts = min === max;
      const confidence = Math.max(0.1, Math.min(0.95, Math.round((0.6 + 0.05 * (ordered.length - candidate.minimum) + (exactAmounts ? 0.1 : 0) - 0.05 * candidate.missing) * 100) / 100));
      series.push({
        cadence: candidate.cadence,
        label: label.slice(0, 120).trimEnd(),
        accountId: anchor.accountId,
        currencyCode: anchor.currencyCode,
        amountMinMinor: min,
        amountMaxMinor: max,
        transactionIds: ordered.map((item) => item.id),
        occurrences: ordered.length,
        confidence,
        missingPeriods: candidate.missing,
        anchorDate: anchor.date,
        runAnchorId: anchor.id,
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
