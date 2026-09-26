import { describe, expect, it } from "vitest";
import { detectRecurring, type RecurringTransaction } from "./recurring";

function transaction(overrides: Partial<RecurringTransaction> & { id: string }): RecurringTransaction {
  return {
    date: "2026-01-01",
    description: "Rent",
    amountMinor: -100000n,
    currencyCode: "EUR",
    accountId: "checking",
    ...overrides,
  };
}

describe("detectRecurring", () => {
  it("finds monthly and weekly series with evidence, ranges, labels, and confidence", () => {
    const result = detectRecurring([
      transaction({ id: "r1", date: "2026-01-01", description: "  ACME Rent " }),
      transaction({ id: "r2", date: "2026-02-01", description: "acme   rent" }),
      transaction({ id: "r3", date: "2026-03-01", description: "ACME RENT" }),
      transaction({ id: "w1", date: "2026-01-02", description: "Gym", amountMinor: -2000n }),
      transaction({ id: "w2", date: "2026-01-09", description: "Gym", amountMinor: -2000n }),
      transaction({ id: "w3", date: "2026-01-16", description: "Gym", amountMinor: -2100n }),
      transaction({ id: "once", date: "2026-01-05", description: "Coffee", amountMinor: -300n }),
      transaction({ id: "twice", date: "2026-01-06", description: "Coffee", amountMinor: -300n }),
    ]);
    expect(result).toHaveLength(2);
    const monthly = result.find((series) => series.cadence === "monthly")!;
    expect(monthly).toMatchObject({
      label: "ACME RENT",
      accountId: "checking",
      currencyCode: "EUR",
      amountMinMinor: -100000n,
      amountMaxMinor: -100000n,
      transactionIds: ["r1", "r2", "r3"],
      occurrences: 3,
    });
    expect(monthly.confidence).toBeGreaterThanOrEqual(0.6);
    const weekly = result.find((series) => series.cadence === "weekly")!;
    expect(weekly.transactionIds).toEqual(["w1", "w2", "w3"]);
    expect(weekly.amountMinMinor).toBe(-2100n);
    expect(weekly.amountMaxMinor).toBe(-2000n);
  });

  it("needs 3 occurrences and never merges across currency, account, sign, or irregular gaps", () => {
    const base = [
      transaction({ id: "a1", date: "2026-01-01", description: "Sub" }),
      transaction({ id: "a2", date: "2026-02-01", description: "Sub" }),
      transaction({ id: "b1", date: "2026-01-01", description: "Sub", currencyCode: "USD" }),
      transaction({ id: "b2", date: "2026-02-01", description: "Sub", currencyCode: "USD" }),
      transaction({ id: "b3", date: "2026-03-01", description: "Sub", currencyCode: "USD" }),
      transaction({ id: "c1", date: "2026-01-01", description: "Sub", accountId: "savings" }),
      transaction({ id: "c2", date: "2026-02-01", description: "Sub", accountId: "savings" }),
      transaction({ id: "c3", date: "2026-03-01", description: "Sub", accountId: "savings" }),
      transaction({ id: "d1", date: "2026-01-01", description: "Sub", amountMinor: 100000n }),
      transaction({ id: "d2", date: "2026-02-01", description: "Sub", amountMinor: 100000n }),
      transaction({ id: "d3", date: "2026-03-01", description: "Sub", amountMinor: 100000n }),
      transaction({ id: "e1", date: "2026-01-01", description: "Flaky", amountMinor: -500n }),
      transaction({ id: "e2", date: "2026-01-03", description: "Flaky", amountMinor: -500n }),
      transaction({ id: "e3", date: "2026-03-01", description: "Flaky", amountMinor: -500n }),
      transaction({ id: "f1", date: "2026-01-01", description: "Drift", amountMinor: -1000n }),
      transaction({ id: "f2", date: "2026-02-01", description: "Drift", amountMinor: -1000n }),
      transaction({ id: "f3", date: "2026-03-01", description: "Drift", amountMinor: -5000n }),
    ];
    const result = detectRecurring(base);
    const ids = result.flatMap((series) => series.transactionIds);
    // Only 2 EUR checking occurrences -> no series; USD/savings/income series stay separate.
    expect(ids).not.toContain("a1");
    expect(result.filter((series) => series.currencyCode === "USD")).toHaveLength(1);
    expect(result.filter((series) => series.accountId === "savings")).toHaveLength(1);
    expect(result.find((series) => series.label === "Sub" && series.amountMinMinor === 100000n)?.occurrences).toBe(3);
    expect(ids).not.toContain("e1");
    expect(ids).not.toContain("f1");
  });
});
