import { formatMoney as formatCurrency } from "@/lib/finance/format";

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

export function seriesKey(args: {
  accountId: string;
  currencyCode: string;
  cadence: string;
  label: string;
}): string {
  return [args.accountId, args.currencyCode, args.cadence, normalizeLabel(args.label)].join("\0");
}

export function formatMoney(minor: string | bigint, currency: string, locale?:string): string {
  const value = typeof minor === "bigint" ? minor : BigInt(minor);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${formatCurrency(abs,currency,locale)}`;
}

export function confidenceToPercent(confidence: number): number {
  return Math.round(confidence * 100);
}
