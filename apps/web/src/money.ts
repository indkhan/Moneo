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

// ISO 4217 minor-unit exponents for the fiat codes touched by R1 fixtures.
// Unknown codes are an explicit error, never a guessed exponent.
const EXPONENTS: Record<string, number> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  JPY: 0,
  KWD: 3,
};

export function currencyExponent(code: string): number {
  const exponent = EXPONENTS[code];
  if (exponent === undefined) throw new Error("unknown_currency");
  return exponent;
}

/** Decimal major-unit string (e.g. "31.42") → minor units for the currency. Exact; rejects excess precision. */
export function parseMinor(amount: string, currency: string): bigint {
  const exponent = currencyExponent(currency);
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

/** Minor units → canonical major-unit decimal string (e.g. 3142n EUR → "31.42"). */
export function formatMinor(minor: bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  if (minor < 0n || minor > MAX_I64) throw new Error("decimal_out_of_range");
  const digits = minor.toString(10).padStart(exponent + 1, "0");
  if (exponent === 0) return digits;
  const whole = digits.slice(0, -exponent).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-exponent);
  return `${whole}.${fraction}`;
}
