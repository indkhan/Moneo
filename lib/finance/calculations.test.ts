import { describe, expect, it } from "vitest";
import { availableToSpend, forecastDaily, netWorth, summarizeCashflow } from "./calculations";

describe("exact financial calculations", () => {
  it("treats an unresolved posted transfer as unknown cashflow before excluding confirmed transfers", () => {
    expect(summarizeCashflow([
      { amountMinor: -1000n, currencyCode: "EUR", status: "posted", kind: "ordinary" },
      { amountMinor: -500n, currencyCode: "EUR", status: "posted", kind: "transfer", reviewReasons: ["classification-review"] },
      { amountMinor: -600n, currencyCode: "EUR", status: "posted", kind: "transfer" },
      { amountMinor: -700n, currencyCode: "EUR", status: "pending", kind: "transfer", reviewReasons: ["classification-review"] },
    ], "EUR")).toEqual({ incomeMinor: 0n, spendingMinor: 1000n, netMinor: -1000n, excludedReviewRows: 1, partial: true });
  });
  it("excludes unresolved classifications and labels cashflow partial", () => {
    expect(summarizeCashflow([
      { amountMinor: -1000n, currencyCode: "EUR", status: "posted", kind: "ordinary" },
      { amountMinor: 5000n, currencyCode: "EUR", status: "posted", kind: "ordinary", reviewReasons: ["source_transfer"] },
    ], "EUR")).toEqual({ incomeMinor: 0n, spendingMinor: 1000n, netMinor: -1000n, excludedReviewRows: 1, partial: true });
  });
  it("keeps large minor-unit totals exact and unknown balances unknown", () => {
    expect(netWorth([{ amountMinor: 9007199254740993n, currencyCode: "EUR" }, { amountMinor: 7n, currencyCode: "EUR" }], "EUR")).toBe(9007199254741000n);
    expect(netWorth([{ amountMinor: null, currencyCode: "EUR" }], "EUR")).toBeNull();
    expect(netWorth([{ amountMinor: 1n, currencyCode: "USD" }], "EUR")).toBeNull();
  });

  it("excludes transfers and pending, and treats refunds as reduced spending", () => {
    expect(summarizeCashflow([
      { amountMinor: 10000n, currencyCode: "EUR", status: "posted", kind: "ordinary" },
      { amountMinor: -4000n, currencyCode: "EUR", status: "posted", kind: "ordinary" },
      { amountMinor: 1000n, currencyCode: "EUR", status: "posted", kind: "refund" },
      { amountMinor: -5000n, currencyCode: "EUR", status: "posted", kind: "transfer" },
      { amountMinor: -3000n, currencyCode: "EUR", status: "pending", kind: "ordinary" },
    ], "EUR")).toEqual({ incomeMinor: 10000n, spendingMinor: 3000n, netMinor: 7000n });
  });

  it("does not combine different currencies in cashflow", () => {
    expect(summarizeCashflow([
      { amountMinor: 100n, currencyCode: "EUR", status: "posted", kind: "ordinary" },
      { amountMinor: 100n, currencyCode: "USD", status: "posted", kind: "ordinary" },
    ], "EUR")).toBeNull();
  });

  it("ignores foreign currencies on excluded pending and transfer rows", () => {
    for (const excluded of [
      { amountMinor: -100n, currencyCode: "USD", status: "pending" as const, kind: "ordinary" as const },
      { amountMinor: -100n, currencyCode: "USD", status: "posted" as const, kind: "transfer" as const },
    ]) {
      expect(summarizeCashflow([
        { amountMinor: -1000n, currencyCode: "EUR", status: "posted", kind: "ordinary" }, excluded,
      ], "EUR")).toEqual({ incomeMinor: 0n, spendingMinor: 1000n, netMinor: -1000n });
    }
  });

  it("evaluates every day and finds an early shortfall, including reservations and pending only once", () => {
    const input = {
      startDate: "2026-10-01", horizonDays: 3, currencyCode: "EUR",
      accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 10000n, availableMinor: 9000n, pendingHoldMinor: 1000n, reservedMinor: 1000n, safetyBufferMinor: 500n }],
      events: [
        { date: "2026-10-02", accountId: "checking", expectedMinor: -6000n, conservativeMinor: -7000n },
        { date: "2026-10-03", accountId: "checking", expectedMinor: 8000n, conservativeMinor: 8000n },
      ],
    };
    const forecast = forecastDaily(input);
    expect(forecast.status).toBe("available");
    if (forecast.status === "available") expect(forecast.days.map(day => day.conservativeMinor)).toEqual([9000n, 2000n, 10000n]);
    expect(availableToSpend(input)).toEqual({ status: "available", amountMinor: 500n, limitingDate: "2026-10-02" });
  });

  it("applies scenario deltas without changing base events", () => {
    const base = { startDate: "2026-10-01", horizonDays: 2, currencyCode: "EUR", accounts: [{ id: "cash", currencyCode: "EUR", balanceMinor: 5000n }], events: [] };
    const scenario = forecastDaily({ ...base, scenarioEvents: [{ date: "2026-10-02", accountId: "cash", expectedMinor: -1000n, conservativeMinor: -1500n, optimisticMinor: -500n }] });
    expect(scenario.status).toBe("available");
    if (scenario.status === "available") expect(scenario.days[1]).toMatchObject({ expectedMinor: 4000n, conservativeMinor: 3500n, optimisticMinor: 4500n });
    expect(base.events).toEqual([]);
  });

  it("reports unknown or mixed-currency inputs as unavailable", () => {
    const base = { startDate: "2026-10-01", horizonDays: 1, currencyCode: "EUR", events: [] };
    expect(availableToSpend({ ...base, accounts: [{ id: "cash", currencyCode: "EUR", balanceMinor: null }] })).toEqual({ status: "unavailable", missingInputs: ["balance:cash"] });
    expect(availableToSpend({ ...base, accounts: [{ id: "cash", currencyCode: "USD", balanceMinor: 1n }] })).toEqual({ status: "unavailable", missingInputs: ["fx:cash"] });
  });
});
