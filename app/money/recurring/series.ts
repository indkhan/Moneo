import { formatMoney as formatCurrency } from "@/lib/finance/format";

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

export function seriesKey(args: {
  accountId: string;
  currencyCode: string;
  cadence: string;
  label: string;
  runAnchorId?: string;
}): string {
  return [args.accountId, args.currencyCode, args.cadence, args.runAnchorId ? `run:${args.runAnchorId}` : normalizeLabel(args.label)].join("\0");
}

export function formatMoney(minor: string | bigint, currency: string, locale?:string): string {
  const value = typeof minor === "bigint" ? minor : BigInt(minor);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${formatCurrency(abs,currency,locale)}`;
}

export function confidenceToPercent(confidence: number): number {
  return Math.round(confidence * 100);
}

// Per-month equivalent in exact minor units, rounded half away from zero (52 weeks, 26 fortnights a year).
const perYear: Record<string, bigint> = { weekly: 52n, biweekly: 26n, monthly: 12n, quarterly: 4n, yearly: 1n };
export function monthlyEquivalent(amountMinor: bigint, cadence: string): bigint {
  const times = perYear[cadence];
  if (!times) throw new Error(`Unknown cadence: ${cadence}`);
  const scaled = amountMinor * times * 2n, sign = scaled < 0n ? -1n : 1n;
  return (scaled + sign * 12n) / 24n;
}
