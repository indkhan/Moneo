import { minorDigits } from "./fx";

export function formatMoney(amountMinor: bigint | string, currencyCode: string): string {
  const value = typeof amountMinor === "string" ? BigInt(amountMinor) : amountMinor;
  const abs = value < 0n ? -value : value;
  const digits = minorDigits(currencyCode);
  const divisor = 10n ** BigInt(digits);
  const whole = abs / divisor;
  if (digits === 0) {
    return `${value < 0n ? "-" : ""}${currencyCode} ${whole}`;
  }
  const fraction = (abs % divisor).toString().padStart(digits, "0");
  return `${value < 0n ? "-" : ""}${currencyCode} ${whole}.${fraction}`;
}

export function formatInputAmount(amountMinor: bigint | string, currencyCode: string): string {
  const value = typeof amountMinor === "string" ? BigInt(amountMinor) : amountMinor;
  const abs = value < 0n ? -value : value;
  const digits = minorDigits(currencyCode);
  const divisor = 10n ** BigInt(digits);
  const whole = abs / divisor;
  if (digits === 0) {
    return `${value < 0n ? "-" : ""}${whole}`;
  }
  const fraction = (abs % divisor).toString().padStart(digits, "0");
  return `${value < 0n ? "-" : ""}${whole}.${fraction}`;
}