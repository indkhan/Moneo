import { minorDigits } from "@/lib/finance/fx";

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

export function formatMoney(minor: string | bigint, currency: string): string {
  const value = typeof minor === "bigint" ? minor : BigInt(minor);
  const abs = value < 0n ? -value : value;
  const digits = minorDigits(currency);
  const base = 10n ** BigInt(digits);
  return `${value < 0n ? "−" : ""}${currency} ${abs / base}${digits ? `.${(abs % base).toString().padStart(digits, "0")}` : ""}`;
}

export function confidenceToPercent(confidence: number): number {
  return Math.round(confidence * 100);
}
