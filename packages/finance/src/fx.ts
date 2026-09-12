import { isKnownCurrency, minorDigitsFor } from "@moneo/shared/currencies";
import { DomainError } from "@moneo/shared/problem";

/**
 * Issue 4.9 — historical FX math and rate policy (pure, no I/O).
 *
 * Architecture §535 contract, in one place:
 *
 * - A conversion uses an exact decimal rate (target major units per one
 *   source major unit) and rounds ONCE at the target minor-unit boundary
 *   with decimal round-half-even. Binary floating point never appears:
 *   every operation below is `BigInt` over an explicit coefficient/scale.
 * - Native `amount_minor`/direction/currency are inputs, never rewritten.
 * - Rate-source decision (recorded before coding, per the issue): Epoch 4
 *   has NO live provider. Published rates are the synthetic monthly anchors
 *   in `FX_SEED_ANCHORS` (source `seed`): EUR-base, 2026-01-01..2026-12-01,
 *   pairs EUR/JPY, EUR/BHD, EUR/USD. Synthetic means no vendor terms apply;
 *   the operational limit is the fixture range itself — anything outside it
 *   is UNAVAILABLE, never filled with today's rate or a future rate.
 * - Maximum-age policy: the latest prior published rate may be used only
 *   within `FX_SEED_MAX_AGE_DAYS` (31) of the requested date. Older coverage
 *   is unavailable. Explicit user-supplied dated rates (source `manual`)
 *   carry their own provenance and are exempt from the age limit.
 * - Identity conversion needs no rate at all.
 * - Non-EUR cross pairs (e.g. JPY→BHD) have no seed path; they stay
 *   unavailable until a manual dated rate is supplied. Completeness
 *   metadata (Issue 4.9 service) surfaces that instead of a false total.
 */

export const CALCULATION_VERSION = "v1";
export const FX_SEED_MAX_AGE_DAYS = 31;
export const FX_RATE_SCALE = 15;

export type FxRateSource = "seed" | "manual" | "identity";

export interface FxSeedAnchor {
  base: string;
  quote: string;
  rateDate: string;
  /** Target major per one source major, exact decimal string. */
  rate: string;
}

function anchor(base: string, quote: string, month: number, rate: string): FxSeedAnchor {
  return { base, quote, rateDate: `2026-${String(month).padStart(2, "0")}-01`, rate };
}

/**
 * Synthetic monthly anchors. Values are deliberately distinct per month so
 * tests can prove WHICH rate date a valuation used. Not market data.
 */
export const FX_SEED_ANCHORS: readonly FxSeedAnchor[] = (() => {
  const anchors: FxSeedAnchor[] = [];
  for (let month = 1; month <= 12; month += 1) {
    anchors.push(
      anchor("EUR", "JPY", month, (169 + month).toFixed(5)),
      anchor("EUR", "BHD", month, (0.41 + month * 0.001).toFixed(5)),
      anchor("EUR", "USD", month, (1.08 + month * 0.002).toFixed(5)),
    );
  }
  return anchors;
})();

function fail(message: string): never {
  throw new DomainError("VALIDATION_FAILED", {
    detail: message,
    errors: [{ field: "fx", message }],
  });
}

export function checkCurrencyPair(base: string, quote: string): void {
  const upperBase = base.toUpperCase();
  const upperQuote = quote.toUpperCase();
  if (!isKnownCurrency(upperBase)) {
    fail(`Unknown currency: ${base}.`);
  }
  if (!isKnownCurrency(upperQuote)) {
    fail(`Unknown currency: ${quote}.`);
  }
  if (upperBase === upperQuote) {
    fail(`Identity pair needs no rate: ${base}.`);
  }
}

/** Split an exact non-negative decimal into coefficient + scale. */
export function parseDecimalRate(rate: string): { coeff: bigint; scale: number } {
  if (!/^\d+(\.\d+)?$/.test(rate)) {
    fail(`Invalid rate (expected non-negative decimal): ${rate}.`);
  }
  const [whole = "0", fraction = ""] = rate.split(".");
  const coeff = BigInt(`${whole === "" ? "0" : whole}${fraction}`);
  if (coeff <= 0n) {
    fail(`Invalid rate (must be > 0): ${rate}.`);
  }
  return { coeff, scale: fraction.length };
}

/** Half-even quotient for positive values: ties round to the even neighbor. */
export function roundHalfEvenQuotient(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    fail("Cannot divide by a non-positive denominator.");
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice < denominator) {
    return quotient;
  }
  if (twice > denominator) {
    return quotient + 1n;
  }
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/**
 * Exact 15dp inverse (quote-per-base → base-per-quote), half-even.
 * Used for *→EUR seed legs, which are stored EUR-base only.
 */
export function invertRate(rate: string): string {
  const { coeff, scale } = parseDecimalRate(rate);
  const scaled = roundHalfEvenQuotient(10n ** BigInt(scale + FX_RATE_SCALE), coeff);
  const text = scaled.toString().padStart(FX_RATE_SCALE + 1, "0");
  const whole = text.slice(0, -FX_RATE_SCALE);
  const fraction = text.slice(-FX_RATE_SCALE);
  return `${whole}.${fraction}`;
}

/**
 * Convert integer minor units at an exact decimal rate.
 * Returns decimal-string minor units in the target currency.
 */
export function convertMinorUnits(
  amountMinor: string,
  sourceCurrency: string,
  rate: string,
  targetCurrency: string,
): string {
  if (!/^(0|[1-9]\d*)$/.test(amountMinor)) {
    fail(`Invalid amountMinor: ${amountMinor}.`);
  }
  let sourceExp: number;
  let targetExp: number;
  try {
    sourceExp = minorDigitsFor(sourceCurrency.toUpperCase());
    targetExp = minorDigitsFor(targetCurrency.toUpperCase());
  } catch {
    fail(`Unknown currency pair: ${sourceCurrency}/${targetCurrency}.`);
  }
  const { coeff, scale } = parseDecimalRate(rate);
  const amount = BigInt(amountMinor);
  const converted = roundHalfEvenQuotient(
    amount * coeff * 10n ** BigInt(targetExp),
    10n ** BigInt(scale) * 10n ** BigInt(sourceExp),
  );
  if (converted > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("Converted amount exceeds safe integer range.");
  }
  return converted.toString();
}

function daysBetween(earlier: string, later: string): number {
  return Math.round(
    (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000,
  );
}

export interface DatedRate {
  rateDate: string;
  rate: string;
}

export interface SelectedRate extends DatedRate {
  source: FxRateSource;
}

/**
 * Latest prior published anchor at or before the requested date, within the
 * maximum-age policy. Future anchors are never eligible; stale coverage is
 * null (unavailable), never a substitution.
 */
export function selectPublishedRate(
  requestedDate: string,
  anchors: readonly DatedRate[],
  maxAgeDays: number = FX_SEED_MAX_AGE_DAYS,
): SelectedRate | null {
  let best: DatedRate | null = null;
  for (const anchorRow of anchors) {
    if (anchorRow.rateDate > requestedDate) {
      continue;
    }
    if (best === null || anchorRow.rateDate > best.rateDate) {
      best = anchorRow;
    }
  }
  if (best === null || daysBetween(best.rateDate, requestedDate) > maxAgeDays) {
    return null;
  }
  return { ...best, source: "seed" };
}

/**
 * Explicit user-supplied dated rates: the latest row on or before the
 * requested date, with no age limit — the user's explicit provenance IS the
 * policy. Future-dated rows never apply retroactively.
 */
export function selectManualRate(
  requestedDate: string,
  rows: readonly DatedRate[],
): SelectedRate | null {
  let best: DatedRate | null = null;
  for (const row of rows) {
    if (row.rateDate > requestedDate) {
      continue;
    }
    if (best === null || row.rateDate > best.rateDate) {
      best = row;
    }
  }
  return best === null ? null : { ...best, source: "manual" };
}

/** Seed anchors for one ordered pair (direct or inverted to the requested direction). */
export function seedAnchorsFor(base: string, quote: string): DatedRate[] {
  const upperBase = base.toUpperCase();
  const upperQuote = quote.toUpperCase();
  const direct = FX_SEED_ANCHORS.filter((a) => a.base === upperBase && a.quote === upperQuote).map(
    (a) => ({ rateDate: a.rateDate, rate: a.rate }),
  );
  if (direct.length > 0) {
    return direct;
  }
  return FX_SEED_ANCHORS.filter((a) => a.base === upperQuote && a.quote === upperBase).map((a) => ({
    rateDate: a.rateDate,
    rate: invertRate(a.rate),
  }));
}
