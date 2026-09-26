// Exact fiat FX conversion.
//
// All money math uses bigint minor units and the rate is an exact ratio
// (integer numerator/denominator, or a decimal string parsed to a ratio),
// so JS floating-point is never authoritative. Derived minor units use
// deterministic half-up rounding on magnitude (away from zero).
//
// Rate meaning: 1 major unit of `from` buys `numerator/denominator`
// major units of `to`.

export const MINOR_DIGITS: Record<string, number> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  JPY: 0,
};

export type ExactRate = { numerator: bigint; denominator: bigint } | string;

export type FxInput = {
  amountMinor: bigint;
  from: string;
  to: string;
  rate: ExactRate | null | undefined;
  source: string;
  date: string; // YYYY-MM-DD rate date
};

export type FxResult =
  | {
      status: "available";
      amountMinor: bigint;
      currencyCode: string;
      converted: { amountMinor: bigint; currencyCode: string };
      rate: { numerator: bigint; denominator: bigint };
      source: string;
      date: string;
    }
  | {
      status: "unavailable";
      missingInputs: string[];
      amountMinor: bigint;
      currencyCode: string;
    };

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function parseRate(rate: ExactRate): { numerator: bigint; denominator: bigint } {
  if (typeof rate === "string") {
    const text = rate.trim();
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error(`Invalid rate: ${rate}`);
    const fraction = match[2] ?? "";
    return { numerator: BigInt(`${match[1]}${fraction}`), denominator: pow10(fraction.length) };
  }
  return { numerator: rate.numerator, denominator: rate.denominator };
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw new Error(`Invalid date: ${date}`);
}

// Rounds the quotient num/den (den > 0) to the nearest integer, half away from zero.
function divRoundHalfUp(num: bigint, den: bigint): bigint {
  const sign = num < 0n ? -1n : 1n;
  const abs = num < 0n ? -num : num;
  return sign * ((abs * 2n + den) / (den * 2n));
}

export function convertFx(input: FxInput): FxResult {
  const { amountMinor, from, to, rate, source, date } = input;
  const fromDigits: number | undefined = MINOR_DIGITS[from];
  const toDigits: number | undefined = MINOR_DIGITS[to];
  if (fromDigits === undefined) return { status: "unavailable", missingInputs: [`currency:${from}`], amountMinor, currencyCode: from };
  if (toDigits === undefined) return { status: "unavailable", missingInputs: [`currency:${to}`], amountMinor, currencyCode: from };
  if (typeof amountMinor !== "bigint") throw new Error("Invalid amount: bigint minor units required");
  validateDate(date);
  if (!source) throw new Error("Invalid source");
  if (from === to) return { status: "available", amountMinor, currencyCode: from,
    converted: { amountMinor, currencyCode: to }, rate: { numerator: 1n, denominator: 1n }, source, date };
  if (rate === null || rate === undefined) return { status: "unavailable", missingInputs: [`rate:${from}->${to}`], amountMinor, currencyCode: from };
  const { numerator, denominator } = parseRate(rate);
  if (denominator <= 0n) throw new Error("Invalid rate: denominator must be positive");
  if (numerator <= 0n) throw new Error("Invalid rate: numerator must be positive");
  const scaled = amountMinor * numerator * pow10(toDigits);
  const divisor = denominator * pow10(fromDigits);
  return { status: "available", amountMinor, currencyCode: from,
    converted: { amountMinor: divRoundHalfUp(scaled, divisor), currencyCode: to },
    rate: { numerator, denominator }, source, date };
}
