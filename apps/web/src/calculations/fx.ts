// E03-S03 shared deterministic historical FX valuation (architecture §535).
// Pure functions: no DB, no side effects, exact minor-unit BigInt arithmetic.
// ECB triangulation via EUR base; manual-rate override; coverage metadata.
// Rates stored as exact decimal strings (target major units per 1 base major unit).

import { DOMParser } from "@xmldom/xmldom";
import { currencyExponent, parseDecimalBigint, formatSignedDecimalBigint } from "../money.ts";

export type FxRate = {
  rateDate: string; // YYYY-MM-DD
  baseCurrency: string;
  targetCurrency: string;
  rate: string; // exact decimal string, target major units per 1 base major unit
  source: "ecb" | "manual" | "identity";
};

export type ValuationInput = {
  snapshotId: string;
  accountId: string;
  asOfDate: string;
  amountMinor: bigint; // signed, in native currency
  currency: string; // native currency
  baseCurrency: string; // target/base currency for valuation
};

export type ValuationResult = {
  snapshotId: string;
  baseCurrency: string;
  valuedAmountMinor: bigint; // signed, in base currency minor units
  coverage: "full" | "partial" | "unavailable";
  maxPriorRateAgeDays: number | null;
  rateDate: string | null;
  rateSource: "ecb" | "manual" | "identity";
};

/** Rational number for exact arithmetic: numerator / denominator */
type Rational = { num: bigint; den: bigint };

/** Parse a decimal string (e.g., "1.1460") into a Rational. */
export function parseRate(rateStr: string): Rational {
  const match = rateStr.match(/^([0-9]+)(?:\.([0-9]*))?$/);
  if (!match) throw new Error("invalid_rate_format");
  const [, whole, fractionRaw] = match as [string, string, string | undefined];
  const fraction = fractionRaw ?? "";
  const num = BigInt(`${whole}${fraction}` || "0");
  const den = 10n ** BigInt(fraction.length);
  return { num, den };
}

/** Multiply two rationals. */
function mulRational(a: Rational, b: Rational): Rational {
  return { num: a.num * b.num, den: a.den * b.den };
}

/** Divide two rationals. */
function divRational(a: Rational, b: Rational): Rational {
  return { num: a.num * b.den, den: a.den * b.num };
}

/** Round half-even (banker's rounding) for BigInt division. */
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division_by_zero");
  const isNegative = numerator < 0n;
  const absNum = isNegative ? -numerator : numerator;
  const quotient = absNum / denominator;
  const remainder = absNum % denominator;
  const half = denominator / 2n;
  let result = quotient;
  if (remainder > half) {
    result += 1n;
  } else if (remainder === half) {
    // Round to even
    if (quotient % 2n !== 0n) {
      result += 1n;
    }
  }
  return isNegative ? -result : result;
}

/** Convert amount using exact rational rate. */
export function convertWithRate(amountMinor: bigint, sourceExp: number, rate: Rational, targetExp: number): bigint {
  // amountMinor / 10^sourceExp * rate * 10^targetExp
  // = amountMinor * rate.num * 10^targetExp / (rate.den * 10^sourceExp)
  const num = amountMinor * rate.num * (10n ** BigInt(targetExp));
  const den = rate.den * (10n ** BigInt(sourceExp));
  return roundHalfEven(num, den);
}

/** Lookup ECB rate for a given date and target currency (base is always EUR). */
export function lookupEcbRate(
  ecbRates: Map<string, Map<string, string>>, // date -> (targetCurrency -> rate string)
  targetCurrency: string,
  asOfDate: string,
  maxPriorAgeDays = 7,
): { rate: string; rateDate: string; coverage: "full" | "partial"; maxPriorRateAgeDays: number } | null {
  const targetExp = currencyExponent(targetCurrency);
  if (targetExp === undefined) return null;

  const dateRates = ecbRates.get(asOfDate);
  if (dateRates) {
    const rate = dateRates.get(targetCurrency);
    if (rate !== undefined) return { rate, rateDate: asOfDate, coverage: "full", maxPriorRateAgeDays: 0 };
  }

  // Find latest prior rate within maxPriorAgeDays
  const asOf = new Date(asOfDate + "T00:00:00Z");
  let bestDate: string | null = null;
  let bestRate: string | null = null;

  for (const [dateStr, rates] of ecbRates) {
    const rateDate = new Date(dateStr + "T00:00:00Z");
    const diffDays = Math.floor((asOf.getTime() - rateDate.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays >= 0 && diffDays <= maxPriorAgeDays) {
      const rate = rates.get(targetCurrency);
      if (rate !== undefined) {
        if (bestDate === null || rateDate > new Date(bestDate + "T00:00:00Z")) {
          bestDate = dateStr;
          bestRate = rate;
        }
      }
    }
  }

  if (bestDate !== null && bestRate !== null) {
    const asOfBest = new Date(bestDate + "T00:00:00Z");
    const ageDays = Math.floor((asOf.getTime() - asOfBest.getTime()) / (1000 * 60 * 60 * 24));
    return { rate: bestRate, rateDate: bestDate, coverage: "partial", maxPriorRateAgeDays: ageDays };
  }

  return null;
}

/** Lookup manual rate override for a specific date and currency pair. */
export function lookupManualRate(
  manualRates: Map<string, Map<string, Map<string, string>>>, // date -> base -> target -> rate string
  baseCurrency: string,
  targetCurrency: string,
  asOfDate: string,
): { rate: string; rateDate: string } | null {
  const baseExp = currencyExponent(baseCurrency);
  const targetExp = currencyExponent(targetCurrency);
  if (baseExp === undefined || targetExp === undefined) return null;

  const dateRates = manualRates.get(asOfDate);
  if (!dateRates) return null;
  const baseRates = dateRates.get(baseCurrency);
  if (!baseRates) return null;
  const rate = baseRates.get(targetCurrency);
  if (rate === undefined) return null;
  return { rate, rateDate: asOfDate };
}

/** Valuate a single balance snapshot to base currency. */
export function valuateSnapshot(
  input: ValuationInput,
  ecbRates: Map<string, Map<string, string>>,
  manualRates: Map<string, Map<string, Map<string, string>>>,
  maxPriorAgeDays = 7,
): ValuationResult {
  const { snapshotId, asOfDate, amountMinor, currency, baseCurrency } = input;

  // Identity conversion
  if (currency === baseCurrency) {
    return {
      snapshotId,
      baseCurrency,
      valuedAmountMinor: amountMinor,
      coverage: "full",
      maxPriorRateAgeDays: 0,
      rateDate: asOfDate,
      rateSource: "identity",
    };
  }

  // Manual rate override takes precedence
  const manual = lookupManualRate(manualRates, currency, baseCurrency, asOfDate);
  if (manual) {
    const rate = parseRate(manual.rate);
    const currencyExp = currencyExponent(currency);
    const baseExp = currencyExponent(baseCurrency);
    if (currencyExp === undefined || baseExp === undefined) {
      return { snapshotId, baseCurrency, valuedAmountMinor: 0n, coverage: "unavailable", maxPriorRateAgeDays: null, rateDate: null, rateSource: "manual" };
    }
    const valued = convertWithRate(amountMinor, currencyExp, rate, baseExp);
    return {
      snapshotId,
      baseCurrency,
      valuedAmountMinor: valued,
      coverage: "full",
      maxPriorRateAgeDays: 0,
      rateDate: manual.rateDate,
      rateSource: "manual",
    };
  }

  // ECB triangulation via EUR
  // We need rate from currency -> baseCurrency
  // ECB has EUR -> X rates. We need currency -> baseCurrency = (EUR -> baseCurrency) / (EUR -> currency)
  // Special cases: if currency is EUR, EUR->currency = 1; if baseCurrency is EUR, EUR->baseCurrency = 1
  let eurToCurrencyRate: string;
  let eurToCurrencyDate: string;
  let eurToCurrencyCoverage: "full" | "partial";
  let eurToCurrencyAgeDays: number;

  if (currency === "EUR") {
    eurToCurrencyRate = "1";
    eurToCurrencyDate = asOfDate;
    eurToCurrencyCoverage = "full";
    eurToCurrencyAgeDays = 0;
  } else {
    const eurToCurrency = lookupEcbRate(ecbRates, currency, asOfDate, maxPriorAgeDays);
    if (!eurToCurrency) {
      return { snapshotId, baseCurrency, valuedAmountMinor: 0n, coverage: "unavailable", maxPriorRateAgeDays: null, rateDate: null, rateSource: "ecb" };
    }
    eurToCurrencyRate = eurToCurrency.rate;
    eurToCurrencyDate = eurToCurrency.rateDate;
    eurToCurrencyCoverage = eurToCurrency.coverage;
    eurToCurrencyAgeDays = eurToCurrency.maxPriorRateAgeDays;
  }

  let eurToBaseRateStr: string;
  let eurToBaseDate: string;
  let eurToBaseCoverage: "full" | "partial";

  if (baseCurrency === "EUR") {
    eurToBaseRateStr = "1";
    eurToBaseDate = asOfDate;
    eurToBaseCoverage = "full";
  } else {
    const eurToBase = lookupEcbRate(ecbRates, baseCurrency, asOfDate, maxPriorAgeDays);
    if (!eurToBase) {
      return { snapshotId, baseCurrency, valuedAmountMinor: 0n, coverage: "unavailable", maxPriorRateAgeDays: null, rateDate: null, rateSource: "ecb" };
    }
    eurToBaseRateStr = eurToBase.rate;
    eurToBaseDate = eurToBase.rateDate;
    eurToBaseCoverage = eurToBase.coverage;
  }

  // Both rates found. Compute triangulated conversion.
  // currency -> baseCurrency = (EUR -> baseCurrency) / (EUR -> currency)
  const eurToBaseRate = parseRate(eurToBaseRateStr);
  const eurToCurrencyRateParsed = parseRate(eurToCurrencyRate);
  const rate = divRational(eurToBaseRate, eurToCurrencyRateParsed);

  const currencyExp = currencyExponent(currency);
  const baseExp = currencyExponent(baseCurrency);

  if (currencyExp === undefined || baseExp === undefined) {
    return { snapshotId, baseCurrency, valuedAmountMinor: 0n, coverage: "unavailable", maxPriorRateAgeDays: null, rateDate: null, rateSource: "ecb" };
  }

  const valuedAmountMinor = convertWithRate(amountMinor, currencyExp, rate, baseExp);

  // Coverage: partial if either rate is partial
  const coverage: "full" | "partial" = eurToBaseCoverage === "partial" || eurToCurrencyCoverage === "partial" ? "partial" : "full";

  // Use the older rate date for max_prior_rate_age
  const rateDate = eurToBaseDate > eurToCurrencyDate ? eurToCurrencyDate : eurToBaseDate;
  const asOf = new Date(asOfDate + "T00:00:00Z");
  const rateDateObj = new Date(rateDate + "T00:00:00Z");
  const maxPriorRateAgeDays = Math.floor((asOf.getTime() - rateDateObj.getTime()) / (1000 * 60 * 60 * 24));

  return {
    snapshotId,
    baseCurrency,
    valuedAmountMinor,
    coverage,
    maxPriorRateAgeDays,
    rateDate,
    rateSource: "ecb",
  };
}

/** Download and parse ECB historical rates XML. */
export async function downloadEcbRates(
  signal?: AbortSignal,
): Promise<{ rates: Map<string, Map<string, string>>; sourceHash: string }> {
  const url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml";
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`ecb_download_failed: ${response.status}`);
  const xmlText = await response.text();

  // Compute SHA256 of the raw XML for checksum verification
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(xmlText));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const sourceHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  // Parse XML
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const parseError = doc.getElementsByTagName("parsererror")[0];
  if (parseError) throw new Error("ecb_xml_parse_error");

  const rates = new Map<string, Map<string, string>>();

  // ECB XML structure: <gesmes:Envelope><Cube><Cube time="YYYY-MM-DD"><Cube currency="USD" rate="1.146"/></Cube></Cube></gesmes:Envelope>
  const cubes = doc.getElementsByTagName("Cube");
  for (let i = 0; i < cubes.length; i++) {
    const cube = cubes[i];
    const time = cube.getAttribute("time");
    if (!time) continue;
    const dateRates = new Map<string, string>();
    const childCubes = cube.getElementsByTagName("Cube");
    for (let j = 0; j < childCubes.length; j++) {
      const cc = childCubes[j];
      const currency = cc.getAttribute("currency");
      const rateStr = cc.getAttribute("rate");
      if (!currency || !rateStr) continue;
      const exp = currencyExponent(currency);
      if (exp === undefined) continue; // Skip unknown currencies
      // Store exact ECB rate string
      dateRates.set(currency, rateStr);
    }
    if (dateRates.size > 0) {
      rates.set(time, dateRates);
    }
  }

  return { rates, sourceHash };
}

/** Upsert ECB rates into database (called from a command/worker). */
export async function upsertEcbRates(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { workspace_id: string; rate_date: string; target_currency: string; rate: string }[] }> },
  workspaceId: string,
  rates: Map<string, Map<string, string>>,
  sourceHash: string,
): Promise<number> {
  let count = 0;
  for (const [date, dateRates] of rates) {
    for (const [currency, rate] of dateRates) {
      await client.query(
        `INSERT INTO fx_rates_ecb (workspace_id, rate_date, target_currency, rate, source_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, rate_date, target_currency) DO UPDATE SET
           rate = EXCLUDED.rate,
           source_hash = EXCLUDED.source_hash`,
        [workspaceId, date, currency, rate, sourceHash],
      );
      count++;
    }
  }
  return count;
}

/** Add or update a manual rate override. */
export async function setManualRate(
  client: { query: (sql: string, params: unknown[]) => Promise<void> },
  workspaceId: string,
  rateDate: string,
  baseCurrency: string,
  targetCurrency: string,
  rate: string,
  auditor: string,
  source: string,
): Promise<void> {
  await client.query(
    `INSERT INTO fx_rates_manual (workspace_id, rate_date, base_currency, target_currency, rate, auditor, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, rate_date, base_currency, target_currency) DO UPDATE SET
       rate = EXCLUDED.rate,
       auditor = EXCLUDED.auditor,
       source = EXCLUDED.source`,
    [workspaceId, rateDate, baseCurrency, targetCurrency, rate, auditor, source],
  );
}