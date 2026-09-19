// E03-S07 deterministic recurring-candidate detection (pure: no DB, no
// side effects). Groups booked rows by normalized description + exact
// minor units + currency + direction; monthly cadence (±3 days) with 2+
// occurrences proposes a candidate, singletons stay sparse (dismissible
// only). Stored rows carry no transfer/refund flags, so detection NEVER
// auto-classifies: every candidate carries a verify-not-transfer warning
// and confirmation demands an explicit user-chosen kind.

import { createHash } from "node:crypto";

export type RecurringInput = {
  id: string;
  amountMinor: string;
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
  effectiveDate: string;
  description: string;
};

export type RecurringCandidate = {
  fingerprint: string;
  description: string;
  amountMinor: string;
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
  occurrences: number;
  firstDate: string;
  lastDate: string;
  status: "candidate" | "sparse";
  warnings: string[];
  transactionIds: string[];
};

export const VERIFY_NOT_TRANSFER = "verify-not-transfer: confirm this is ordinary spend or income, not a transfer, refund, fee or credit repayment — stored rows carry no counterparty flags, so only you can rule that out";

export function normalizeDescription(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, " ");
}

export function fingerprintFor(normalized: string, amountMinor: string, currency: string, direction: string): string {
  return createHash("sha256").update(`${normalized}|${amountMinor}|${currency}|${direction}|monthly`).digest("hex");
}

function monthDistance(a: string, b: string): number {
  // Whole-calendar-month distance between YYYY-MM-DD dates.
  const [ay, am] = [Number(a.slice(0, 4)), Number(a.slice(5, 7))];
  const [by, bm] = [Number(b.slice(0, 4)), Number(b.slice(5, 7))];
  return (by - ay) * 12 + (bm - am);
}

function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

function monthlyChain(dates: string[]): boolean {
  // Sorted dates form a monthly chain when each step is 1 calendar month
  // apart and the day-of-month stays within ±3 days.
  for (let i = 1; i < dates.length; i++) {
    if (monthDistance(dates[i - 1], dates[i]) !== 1) return false;
    if (Math.abs(dayOfMonth(dates[i]) - dayOfMonth(dates[i - 1])) > 3) return false;
  }
  return true;
}

export function detectCandidates(items: RecurringInput[]): RecurringCandidate[] {
  const groups = new Map<string, { normalized: string; rows: RecurringInput[] }>();
  for (const item of items) {
    const normalized = normalizeDescription(item.description);
    if (normalized.length === 0) continue;
    const fp = fingerprintFor(normalized, item.amountMinor, item.currency, item.direction);
    const group = groups.get(fp) ?? { normalized, rows: [] };
    group.rows.push(item);
    groups.set(fp, group);
  }
  const out: RecurringCandidate[] = [];
  for (const [fp, group] of groups) {
    const first = group.rows[0];
    const dates = group.rows.map((r) => r.effectiveDate).sort();
    if (group.rows.length >= 2 && monthlyChain(dates)) {
      out.push({
        fingerprint: fp,
        description: first.description.trim(),
        amountMinor: first.amountMinor,
        currency: first.currency,
        direction: first.direction,
        occurrences: group.rows.length,
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
        status: "candidate",
        warnings: [VERIFY_NOT_TRANSFER],
        transactionIds: group.rows.map((r) => r.id),
      });
    } else {
      out.push({
        fingerprint: fp,
        description: first.description.trim(),
        amountMinor: first.amountMinor,
        currency: first.currency,
        direction: first.direction,
        occurrences: group.rows.length,
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
        status: "sparse",
        warnings: group.rows.length < 2 ? ["insufficient-history: a single occurrence cannot establish a schedule"] : ["irregular-cadence: occurrences do not form a monthly chain"],
        transactionIds: group.rows.map((r) => r.id),
      });
    }
  }
  out.sort((a, b) => (a.firstDate < b.firstDate ? -1 : 1));
  return out;
}
