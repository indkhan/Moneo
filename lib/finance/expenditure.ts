import { z } from "zod";
import { convertFx, minorDigits } from "./fx";

export type ExpenditurePosting = { id: string; parentTransactionId?: string; amountMinor: bigint; currencyCode: string; postedOn: string; status: string; kind: string; reviewReasons?: string[]; version?: number; accountId?: string };
export type ExpenditureRate = { id: string; fromCurrency: string; toCurrency: string; rateText: string; rateDate: string; source: string };
export function expenditurePosting(row: { id: string; parent_transaction_id?: string; account_id: string; posted_on: string; amount_minor: string; currency_code: string; status: string; kind: string; review_reasons?: string[]; version?: number }): ExpenditurePosting {
  return { id: row.id, parentTransactionId: row.parent_transaction_id, accountId: row.account_id, postedOn: row.posted_on, amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code, status: row.status, kind: row.kind, reviewReasons: row.review_reasons, version: row.version };
}
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
  const postings: { id: string; parentTransactionId?: string; parentAmountMinor: string | null; parentAmountBasis: "canonical-record" | "effective-components" | "unavailable"; sourcePostings: { id: string; originalAmountMinor: string }[]; accountId?: string; kind: string; version?: number; postedOn: string; originalAmountMinor: string; originalCurrencyCode: string; reportingAmountMinor: string | null; rate: { id: string | null; source: string; date: string; numerator: string; denominator: string } | null; rounding: { scaledNumerator: string; scaledDenominator: string; roundedMinor: string } | null }[] = [];
  let incomplete = false;
  let scopedTransactionCount = 0;
  const groups = new Map<string, ExpenditurePosting & { sourcePostings: { id: string; originalAmountMinor: string }[] }>();
  const parents = new Map<string, { metadata: string; amount: bigint | null; kind: string | null; effectiveAmount: bigint; kinds: Set<string> }>();
  const ids = new Set<string>();
  for (const row of rows) {
    z.iso.date().parse(row.postedOn);
    if (typeof row.amountMinor !== "bigint") throw new Error("Bigint minor units required");
    minorDigits(row.currencyCode);
    if (ids.has(row.id)) throw new Error("Duplicate effective posting evidence");
    ids.add(row.id);
    const parentId = row.parentTransactionId ?? row.id;
    const metadata = JSON.stringify([row.accountId, row.currencyCode, row.postedOn, row.status, row.version, row.reviewReasons ?? []]);
    const parent = parents.get(parentId) ?? { metadata, amount: null, kind: null, effectiveAmount: 0n, kinds: new Set<string>() };
    if (parent.metadata !== metadata) throw new Error("Inconsistent canonical parent evidence");
    if (row.id === parentId) { parent.amount = row.amountMinor; parent.kind = row.kind; }
    parent.effectiveAmount += row.amountMinor;
    parent.kinds.add(row.kind);
    parents.set(parentId, parent);
    const key = `${parentId}:${row.kind}`;
    const group = groups.get(key);
    const source = { id: row.id, originalAmountMinor: row.amountMinor.toString() };
    if (group) { group.amountMinor += row.amountMinor; group.id = parentId; group.sourcePostings.push(source); }
    else groups.set(key, { ...row, sourcePostings: [source] });
  }
  for (const parent of parents.values()) if (parent.kinds.size > 1 &&
    (parent.kinds.size !== 2 || !parent.kinds.has("ordinary") || !parent.kinds.has("transfer") || parent.kind !== "transfer")) throw new Error("Inconsistent canonical parent classification");
  for (const row of groups.values()) {
    if (row.postedOn < options.from || row.postedOn > options.to || (options.accountIds && !options.accountIds.includes(row.accountId ?? ""))) continue;
    scopedTransactionCount += row.sourcePostings.length;
    const exclude = (reason: string) => exclusions.push({ id: row.id, reason, currencyCode: row.currencyCode, postedOn: row.postedOn, originalAmountMinor: row.amountMinor.toString() });
    if (row.status !== "posted") { exclude("pending"); continue; }
    // Classification uncertainty precedes transfer exclusion: an unresolved
    // transfer might prove ordinary spending after review.
    if (row.reviewReasons?.length || !["ordinary", "refund", "transfer"].includes(row.kind)) { exclude("classification-review"); incomplete = true; continue; }
    if (row.kind === "transfer") { exclude("transfer"); continue; }
    add(perCurrency[row.currencyCode] ??= empty(), row.amountMinor, row.kind);
    const parent = parents.get(row.parentTransactionId ?? row.id)!;
    const parentAmountBasis = parent.amount !== null ? "canonical-record" as const : parent.kinds.size === 1 ? "effective-components" as const : "unavailable" as const;
    const evidence = { id: row.id, parentTransactionId: row.parentTransactionId, parentAmountMinor: (parent.amount ?? (parent.kinds.size === 1 ? parent.effectiveAmount : null))?.toString() ?? null, parentAmountBasis, sourcePostings: row.sourcePostings.sort((a, b) => a.id.localeCompare(b.id)), accountId: row.accountId, kind: row.kind, version: row.version, postedOn: row.postedOn, originalAmountMinor: row.amountMinor.toString(), originalCurrencyCode: row.currencyCode };
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
    scopedTransactionCount, includedTransactionCount: postings.filter(row => options.view === "original" || row.reportingAmountMinor !== null).reduce((count, row) => count + row.sourcePostings.length, 0),
    includedCanonicalPostingCount: postings.filter(row => options.view === "original" || row.reportingAmountMinor !== null).length,
    policy: { rateDate: "exact-posting-date" as const, pair: "direct" as const, rounding: "per-posting-half-away-from-zero" as const, aggregation: "canonical-parent-financial-kind" as const },
    limitation: incomplete ? "Missing conversion evidence or excluded classifications are unknown; partial totals are not upper or lower bounds." : null };
}
