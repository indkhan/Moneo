// E01-S04 exact-representation boundary (architecture §158). Minor-unit
// amounts and BIGINT versions cross every JSON boundary as decimal strings
// and are computed with BigInt only — never JavaScript numbers, never
// floats. parseDecimalBigint is consumed today by command version parsing;
// parseMinor/formatMinor are the reviewed §158 contract E03-S01 consumes for
// balances (golden-tested here, not speculative).

const DECIMAL_STRING = /^[0-9]+$/;
const MAX_I64 = (1n << 63n) - 1n;

/** Strict canonical decimal-string → BigInt. Rejects signs, whitespace, leading zeros (except "0" itself) and non-digits. */
export function parseDecimalBigint(value: unknown): bigint {
  if (typeof value !== "string" || !DECIMAL_STRING.test(value)) throw new Error("not_decimal_string");
  if (value.length > 1 && value.startsWith("0")) throw new Error("not_canonical_decimal");
  const parsed = BigInt(value);
  if (parsed > MAX_I64) throw new Error("decimal_out_of_range");
  return parsed;
}

/** Canonical decimal string for a BIGINT-range value (rejects negatives). */
export function formatDecimalBigint(value: bigint): string {
  if (value < 0n || value > MAX_I64) throw new Error("decimal_out_of_range");
  return value.toString(10);
}

/** Canonical decimal string for a signed BIGINT-range value. */
export function formatSignedDecimalBigint(value: bigint): string {
  if (value < -MAX_I64 || value > MAX_I64) throw new Error("decimal_out_of_range");
  return value.toString(10);
}

// ISO 4217 minor-unit exponents for the fiat codes touched by R1 fixtures.
// Unknown codes return undefined, never a guessed exponent.
const EXPONENTS: Record<string, number> = {
  // ECB reference currencies + R1 fixtures
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  JPY: 0,
  KWD: 3,
  CZK: 2,
  DKK: 2,
  HUF: 2,
  PLN: 2,
  RON: 2,
  SEK: 2,
  ISK: 2,
  NOK: 2,
  TRY: 2,
  AUD: 2,
  BRL: 2,
  CAD: 2,
  CNY: 2,
  HKD: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  KRW: 0,
  MXN: 2,
  MYR: 2,
  NZD: 2,
  PHP: 2,
  SGD: 2,
  THB: 2,
  ZAR: 2,
};

export function currencyExponent(code: string): number | undefined {
  return EXPONENTS[code];
}

/** Decimal major-unit string (e.g. "31.42") → minor units for the currency. Exact; rejects excess precision. */
export function parseMinor(amount: string, currency: string): bigint {
  const exponent = currencyExponent(currency);
  if (exponent === undefined) throw new Error("unknown_currency");
  if (typeof amount !== "string") throw new Error("not_decimal_string");
  const match = amount.match(/^([0-9]+)(?:\.([0-9]*))?$/);
  if (!match) throw new Error("not_decimal_string");
  const [, whole, fractionRaw] = match as [string, string, string | undefined];
  const fraction = (fractionRaw ?? "").replace(/_+$/, "");
  if (fraction.length > exponent) throw new Error("excess_precision");
  const padded = fraction.padEnd(exponent, "0");
  const minor = BigInt(`${whole.replace(/^0+(?=\d)/, "")}${padded}` || "0");
  if (minor > MAX_I64) throw new Error("decimal_out_of_range");
  return minor;
}

/** Signed decimal major-unit string (e.g. "-31.42" or "100.00") → signed minor units for the currency. Exact; rejects excess precision. */
export function parseSignedMinor(amount: string, currency: string): bigint {
  const exponent = currencyExponent(currency);
  if (exponent === undefined) throw new Error("unknown_currency");
  if (typeof amount !== "string") throw new Error("not_decimal_string");
  const match = amount.match(/^(-?)([0-9]+)(?:\.([0-9]*))?$/);
  if (!match) throw new Error("not_decimal_string");
  const [, sign, whole, fractionRaw] = match as [string, string, string, string | undefined];
  const fraction = (fractionRaw ?? "").replace(/_+$/, "");
  if (fraction.length > exponent) throw new Error("excess_precision");
  const padded = fraction.padEnd(exponent, "0");
  const minor = BigInt(`${whole.replace(/^0+(?=\d)/, "")}${padded}` || "0");
  if (minor > MAX_I64) throw new Error("decimal_out_of_range");
  return sign === "-" ? -minor : minor;
}

/** Minor units → canonical major-unit decimal string (e.g. 3142n EUR → "31.42"). */
export function formatMinor(minor: bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === undefined) throw new Error("unknown_currency");
  if (minor < 0n || minor > MAX_I64) throw new Error("decimal_out_of_range");
  const digits = minor.toString(10).padStart(exponent + 1, "0");
  if (exponent === 0) return digits;
  const whole = digits.slice(0, -exponent).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-exponent);
  return `${whole}.${fraction}`;
}
