import {expect, it} from "vitest";
import {detectRecurring, type RecurringTransaction} from "./recurring";

const posting = (id: string, date: string, description = "ACME subscription", amountMinor = -2000n): RecurringTransaction =>
  ({id, date, description, amountMinor, accountId: "synthetic-checking", currencyCode: "EUR"});

it("retains a repeated merchant run when monthly invoice references change", () => {
  const result = detectRecurring([
    posting("jan", "2026-01-31", "ACME subscription invoice 1001"),
    posting("feb", "2026-02-28", "ACME subscription invoice 1002"),
    posting("mar", "2026-03-31", "ACME subscription invoice 1003"),
  ]);
  expect(result).toEqual(expect.arrayContaining([expect.objectContaining({cadence: "monthly", transactionIds: ["jan", "feb", "mar"]})]));
});

it("keeps a recurring run separate from an extra same-merchant purchase", () => {
  const result = detectRecurring([
    posting("jan", "2026-01-03"), posting("extra", "2026-01-17", "ACME subscription", -7500n),
    posting("feb", "2026-02-03"), posting("mar", "2026-03-03"),
  ]);
  expect(result).toEqual(expect.arrayContaining([expect.objectContaining({cadence: "monthly", transactionIds: ["jan", "feb", "mar"], amountMinMinor: -2000n, amountMaxMinor: -2000n})]));
  expect(result.flatMap(series => series.transactionIds)).not.toContain("extra");
});

it("retains monthly evidence across a missing month without inventing an occurrence", () => {
  const result = detectRecurring([
    posting("jan", "2026-01-31"), posting("feb", "2026-02-28"),
    posting("apr", "2026-04-30"), posting("may", "2026-05-31"),
  ]);
  expect(result).toEqual(expect.arrayContaining([expect.objectContaining({cadence: "monthly", transactionIds: ["jan", "feb", "apr", "may"], occurrences: 4, missingPeriods: 1})]));
});

it.each([
  {cadence: "quarterly", dates: ["2026-01-31", "2026-04-30", "2026-07-31"]},
  {cadence: "yearly", dates: ["2024-02-29", "2025-02-28", "2026-02-28"]},
  {cadence: "biweekly", dates: ["2026-01-02", "2026-01-16", "2026-01-30"]},
])("finds calendar-anchored $cadence runs with exact observed amounts", ({cadence, dates}) => {
  const result = detectRecurring(dates.map((date, index) => posting(`observed-${index}`, date, "ACME fee", -9007199254740993n)));
  expect(result).toEqual(expect.arrayContaining([expect.objectContaining({cadence, amountMinMinor: -9007199254740993n, amountMaxMinor: -9007199254740993n, transactionIds: ["observed-0", "observed-1", "observed-2"]})]));
});

it("keeps separate observed runs when the gap exceeds the disclosed missing-period limit", () => {
  const result = detectRecurring([
    posting("jan", "2025-01-03"), posting("feb", "2025-02-03"), posting("mar", "2025-03-03"),
    posting("oct", "2026-10-03"), posting("nov", "2026-11-03"), posting("dec", "2026-12-03"),
  ]);
  expect(result.filter(series => series.cadence === "monthly").map(series => series.transactionIds)).toEqual([["jan", "feb", "mar"], ["oct", "nov", "dec"]]);
});

it("uses recorded merchant identity across varying text without merging unrelated merchant identities", () => {
  const result = detectRecurring([
    {...posting("jan", "2026-01-03", "ACME online"), merchantId: "owned-acme"},
    {...posting("feb", "2026-02-03", "ACME direct debit"), merchantId: "owned-acme"},
    {...posting("mar", "2026-03-03", "ACME web"), merchantId: "owned-acme"},
    {...posting("different", "2026-04-03", "ACME online"), merchantId: "owned-different"},
  ]);
  expect(result.flatMap(series => series.transactionIds)).toEqual(["jan", "feb", "mar"]);
});
