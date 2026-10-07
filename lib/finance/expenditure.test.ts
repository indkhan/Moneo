import { describe, expect, it } from "vitest";
import { reportExpenditure, type ExpenditurePosting } from "./expenditure";

const posting = (id: string, amountMinor: bigint, currencyCode = "USD", extra: Partial<ExpenditurePosting> = {}): ExpenditurePosting => ({ id, amountMinor, currencyCode, postedOn: "2026-10-07", status: "posted", kind: "ordinary", ...extra });
const options = { view: "base" as const, currencyCode: "EUR", from: "2026-10-01", to: "2026-10-31" };
const rate = { id: "rate-7", fromCurrency: "USD", toCurrency: "EUR", rateText: "0.905", rateDate: "2026-10-07", source: "synthetic" };

describe("authoritative expenditure reporting", () => {
  it("combines dated converted postings and preserves exact original and rounding evidence", () => {
    const result = reportExpenditure([posting("eur", -100n, "EUR"), posting("usd", -101n)], [rate], options);
    expect(result).toMatchObject({ status: "complete", totals: { incomeMinor: "0", spendingMinor: "191", netMinor: "-191" },
      perCurrency: { EUR: { spendingMinor: "100" }, USD: { spendingMinor: "101" } }, policy: { rateDate: "exact-posting-date", rounding: "per-posting-half-away-from-zero" } });
    expect(result.postings[1]).toMatchObject({ id: "usd", originalAmountMinor: "-101", originalCurrencyCode: "USD", reportingAmountMinor: "-91",
      rate: { id: "rate-7", source: "synthetic", date: "2026-10-07", numerator: "905", denominator: "1000" },
      rounding: { scaledNumerator: "-9140500", scaledDenominator: "100000", roundedMinor: "-91" } });
  });
  it("does not substitute stale, future or reverse rates and never labels a partial sum authoritative", () => {
    const result = reportExpenditure([posting("a", -100n)], [ { ...rate, rateDate: "2026-10-06" }, { ...rate, rateDate: "2026-10-08" }, { ...rate, fromCurrency: "EUR", toCurrency: "USD" } ], options);
    expect(result).toMatchObject({ status: "incomplete", totals: null, availableTotals: { spendingMinor: "0" }, perCurrency: { USD: { spendingMinor: "100" } },
      exclusions: [{ id: "a", reason: "missing-rate", currencyCode: "USD", postedOn: "2026-10-07" }] });
  });
  it("offers original currency totals without requiring conversion", () => {
    const result = reportExpenditure([posting("a", -100n), posting("b", -50n, "EUR")], [], { ...options, view: "original" });
    expect(result).toMatchObject({ status: "complete", totals: { spendingMinor: "50" }, perCurrency: { USD: { spendingMinor: "100" }, EUR: { spendingMinor: "50" } } });
    expect(result.postings[0].reportingAmountMinor).toBeNull();
  });
  it("keeps refunds and transfer fees exact while excluding principal, pending and unknown classifications", () => {
    const result = reportExpenditure([posting("fee", -101n), posting("refund", 1n, "USD", { kind: "refund" }), posting("principal", -500n, "USD", { kind: "transfer" }), posting("pending", -99n, "USD", { status: "pending" }), posting("unknown", 100n, "USD", { reviewReasons: ["kind"] })], [rate], options);
    expect(result).toMatchObject({ status: "incomplete", totals: null, availableTotals: { spendingMinor: "90" }, exclusions: [ { id: "principal", reason: "transfer" }, { id: "pending", reason: "pending" }, { id: "unknown", reason: "classification-review" } ] });
  });
  it.each([["JPY", -1n, "-1"], ["USD", -100n, "-1"], ["KWD", -1000n, "-1"], ["CLF", -10000n, "-1"]])("converts %s accounting precision exactly", (currencyCode, amount, expected) => {
    const result = reportExpenditure([posting("precision", amount, currencyCode)], [{ ...rate, fromCurrency: currencyCode, toCurrency: "JPY", rateText: "1" }], { ...options, currencyCode: "JPY" });
    expect(result.postings[0].reportingAmountMinor).toBe(expected);
  });
  it("recomputes correction amount and date with the newly applicable rate", () => {
    const rates = [rate, { ...rate, id: "rate-8", rateDate: "2026-10-08", rateText: "2" }];
    const result = reportExpenditure([posting("corrected", -200n, "USD", { postedOn: "2026-10-08", version: 2 })], rates, options);
    expect(result.postings[0]).toMatchObject({ version: 2, postedOn: "2026-10-08", originalAmountMinor: "-200", reportingAmountMinor: "-400", rate: { id: "rate-8" } });
  });
  it("rounds each signed posting independently rather than a combined floating total", () => {
    const result = reportExpenditure([posting("one", -1n), posting("two", -1n), posting("refund", 1n, "USD", { kind: "refund" })], [{ ...rate, rateText: "0.5" }], options);
    expect(result.totals?.spendingMinor).toBe("1");
    expect(result.postings.map(row => row.reportingAmountMinor)).toEqual(["-1", "-1", "1"]);
  });
  it("rejects invalid report boundaries and never accepts invalid or ambiguous rate evidence", () => {
    expect(() => reportExpenditure([], [], { ...options, from: "2026-10-32" })).toThrow();
    expect(() => reportExpenditure([], [], { ...options, from: "2026-11-01" })).toThrow();
    for (const rateText of ["0", "-1", "1e2"]) {
      const result = reportExpenditure([posting("a", -1n)], [{ ...rate, rateText }], options);
      expect(result).toMatchObject({ status: "incomplete", totals: null, exclusions: [{ reason: "invalid-rate" }] });
    }
    expect(reportExpenditure([posting("a", -1n)], [rate, { ...rate, id: "other" }], options)).toMatchObject({ totals: null, exclusions: [{ reason: "ambiguous-rate" }] });
  });
  it("applies account and posting-date filters before determining report incompleteness", () => {
    const accountId = "00000000-0000-4000-8000-000000000001";
    const result = reportExpenditure([posting("a", -100n, "EUR", { accountId }), posting("b", -100n, "USD", { accountId: "other" }), posting("old", -100n, "USD", { accountId, postedOn: "2026-09-30" })], [], { ...options, accountIds: [accountId] });
    expect(result).toMatchObject({ status: "complete", totals: { spendingMinor: "100" }, scopedTransactionCount: 1, includedTransactionCount: 1 });
  });
  it("treats unresolved transfer classification as unknown expenditure rather than harmless exclusion", () => {
    expect(reportExpenditure([posting("unknown-transfer", -1n, "USD", { kind: "transfer", reviewReasons: ["kind"] })], [], options)).toMatchObject({ status: "incomplete", totals: null, exclusions: [{ reason: "classification-review" }] });
  });
  it("retains posting kind, account and canonical parent identity for split and refund audit trails", () => {
    const row = { ...posting("split", 1n, "USD", { kind: "refund", accountId: "synthetic-account" }), parentTransactionId: "canonical-parent" };
    expect(reportExpenditure([row], [rate], options).postings[0]).toMatchObject({ kind: "refund", accountId: "synthetic-account", parentTransactionId: "canonical-parent" });
  });
  it("labels complete conversion coverage as accepted-record evidence rather than complete statements", () => {
    expect(reportExpenditure([posting("a", -100n)], [rate], options)).toMatchObject({ conversionCoverage: { status: "complete", missingRateCount: 0, excludedClassificationCount: 0 }, resultBasis: "accepted reviewed postings; statement completeness is not established" });
    expect(reportExpenditure([posting("a", -100n), posting("unknown", -1n, "EUR", { reviewReasons: ["kind"] })], [], options)).toMatchObject({ conversionCoverage: { status: "incomplete", missingRateCount: 1, excludedClassificationCount: 1 } });
  });
});
