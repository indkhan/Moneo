import { minorDigits } from "./fx";

function exactMinor(value: bigint | string | number): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Unsafe minor amount");
  return BigInt(value);
}

export function formatMoney(amountMinor: bigint | string | number, currencyCode: string): string {
  const value = exactMinor(amountMinor);
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

export function formatInputAmount(amountMinor: bigint | string | number, currencyCode: string): string {
  const value = exactMinor(amountMinor);
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
