import { z } from "zod";
import { convertFx, minorDigits } from "./fx";

export type ExpenditurePosting = { id: string; parentTransactionId?: string; amountMinor: bigint; currencyCode: string; postedOn: string; status: string; kind: string; reviewReasons?: string[]; version?: number; accountId?: string };
export type ExpenditureRate = { id: string; fromCurrency: string; toCurrency: string; rateText: string; rateDate: string; source: string };
export const expenditureInput = z.object({ view: z.enum(["original", "base"]), currencyCode: z.string().regex(/^[A-Z]{3}$/).refine(code => { try { minorDigits(code); return true; } catch { return false; } }), from: z.iso.date(), to: z.iso.date(), accountIds: z.array(z.uuid()).max(100).optional() }).refine(value => value.from <= value.to, "From date is after to date");
export type ExpenditureOptions = z.infer<typeof expenditureInput>;
type Totals = { incomeMinor: bigint; spendingMinor: bigint };
const empty = (): Totals => ({ incomeMinor: 0n, spendingMinor: 0n });
const serialize = (totals: Totals) => ({ incomeMinor: totals.incomeMinor.toString(), spendingMinor: totals.spendingMinor.toString(), netMinor: (totals.incomeMinor - totals.spendingMinor).toString() });
function add(totals: Totals, amount: bigint, kind: string) {
  if (kind === "refund") totals.spendingMinor -= amount;
  else if (amount > 0n) totals.incomeMinor += amount;
  else totals.spendingMinor -= amount;
}

// Direct exact-date evidence only. No previous-day carry, inverse or triangulated
// rate is implied. Round each signed posting before aggregating, using convertFx.
export function reportExpenditure(rows: ExpenditurePosting[], rates: ExpenditureRate[], input: ExpenditureOptions) {
  const options = expenditureInput.parse(input);
  const perCurrency: Record<string, Totals> = {};
  const available = empty();
  const exclusions: { id: string; reason: string; currencyCode: string; postedOn: string; originalAmountMinor: string }[] = [];
  const postings: { id: string; parentTransactionId?: string; accountId?: string; kind: string; version?: number; postedOn: string; originalAmountMinor: string; originalCurrencyCode: string; reportingAmountMinor: string | null; rate: { id: string | null; source: string; date: string; numerator: string; denominator: string } | null; rounding: { scaledNumerator: string; scaledDenominator: string; roundedMinor: string } | null }[] = [];
  let incomplete = false;
  let scopedTransactionCount = 0;
  for (const row of rows) {
    z.iso.date().parse(row.postedOn);
    if (typeof row.amountMinor !== "bigint") throw new Error("Bigint minor units required");
    minorDigits(row.currencyCode);
    if (row.postedOn < options.from || row.postedOn > options.to || (options.accountIds && !options.accountIds.includes(row.accountId ?? ""))) continue;
    scopedTransactionCount++;
    const exclude = (reason: string) => exclusions.push({ id: row.id, reason, currencyCode: row.currencyCode, postedOn: row.postedOn, originalAmountMinor: row.amountMinor.toString() });
    if (row.status !== "posted") { exclude("pending"); continue; }
    // Classification uncertainty precedes transfer exclusion: an unresolved
    // transfer might prove ordinary spending after review.
    if (row.reviewReasons?.length || !["ordinary", "refund", "transfer"].includes(row.kind)) { exclude("classification-review"); incomplete = true; continue; }
    if (row.kind === "transfer") { exclude("transfer"); continue; }
    add(perCurrency[row.currencyCode] ??= empty(), row.amountMinor, row.kind);
    const evidence = { id: row.id, parentTransactionId: row.parentTransactionId, accountId: row.accountId, kind: row.kind, version: row.version, postedOn: row.postedOn, originalAmountMinor: row.amountMinor.toString(), originalCurrencyCode: row.currencyCode };
    if (options.view === "original") {
      if (row.currencyCode === options.currencyCode) add(available, row.amountMinor, row.kind);
      postings.push({ ...evidence, reportingAmountMinor: row.currencyCode === options.currencyCode ? row.amountMinor.toString() : null, rate: null, rounding: null });
      continue;
    }
    const matching = rates.filter(rate => rate.fromCurrency === row.currencyCode && rate.toCurrency === options.currencyCode && rate.rateDate === row.postedOn);
    const sameCurrency = row.currencyCode === options.currencyCode;
    const rate = matching.length === 1 ? matching[0] : undefined;
    let conversion;
    try {
      conversion = convertFx({ amountMinor: row.amountMinor, from: row.currencyCode, to: options.currencyCode, rate: rate?.rateText, source: sameCurrency ? "identity" : rate?.source ?? "missing", date: row.postedOn });
    } catch { conversion = null; }
    if (!conversion || conversion.status !== "available" || (!sameCurrency && !rate?.id)) {
      exclude(matching.length > 1 ? "ambiguous-rate" : rate ? "invalid-rate" : "missing-rate"); incomplete = true;
      postings.push({ ...evidence, reportingAmountMinor: null, rate: null, rounding: null });
      continue;
    }
    const converted = conversion.converted.amountMinor;
    add(available, converted, row.kind);
    postings.push({ ...evidence, reportingAmountMinor: converted.toString(), rate: { id: sameCurrency ? null : rate!.id, source: conversion.source, date: conversion.date, numerator: conversion.rate.numerator.toString(), denominator: conversion.rate.denominator.toString() }, rounding: {
      scaledNumerator: (row.amountMinor * conversion.rate.numerator * 10n ** BigInt(minorDigits(options.currencyCode))).toString(),
      scaledDenominator: (conversion.rate.denominator * 10n ** BigInt(minorDigits(row.currencyCode))).toString(), roundedMinor: converted.toString(),
    } });
  }
  return { ...options, status: incomplete ? "incomplete" as const : "complete" as const, totals: incomplete ? null : serialize(available), availableTotals: serialize(available), perCurrency: Object.fromEntries(Object.entries(perCurrency).map(([currency, total]) => [currency, serialize(total)])), postings, exclusions,
    resultBasis: "accepted reviewed postings; statement completeness is not established" as const,
    conversionCoverage: { status: incomplete ? "incomplete" as const : "complete" as const, missingRateCount: exclusions.filter(row => row.reason === "missing-rate").length, invalidRateCount: exclusions.filter(row => row.reason === "invalid-rate").length, ambiguousRateCount: exclusions.filter(row => row.reason === "ambiguous-rate").length, excludedClassificationCount: exclusions.filter(row => row.reason === "classification-review").length },
    scopedTransactionCount, includedTransactionCount: postings.filter(row => options.view === "original" || row.reportingAmountMinor !== null).length,
    policy: { rateDate: "exact-posting-date" as const, pair: "direct" as const, rounding: "per-posting-half-away-from-zero" as const },
    limitation: incomplete ? "Missing conversion evidence or excluded classifications are unknown; partial totals are not upper or lower bounds." : null };
}
