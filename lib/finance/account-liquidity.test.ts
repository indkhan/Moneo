import { describe, expect, it } from "vitest";
import * as calculations from "./calculations";

const input: calculations.ForecastInput = {
  startDate: "2026-10-07", horizonDays: 3, currencyCode: "EUR",
  accounts: [
    { id: "checking", currencyCode: "EUR", balanceMinor: 10000n },
    { id: "savings", currencyCode: "EUR", balanceMinor: 100000n },
  ],
  events: [{ date: "2026-10-08", accountId: "checking", expectedMinor: -50000n, name: "Bill" }],
};

describe("account liquidity", () => {
  it("retains aggregate EUR 600 but exposes dated checking EUR 400 funding gap", () => {
    expect(calculations.availableToSpend(input)).toMatchObject({ amountMinor: 60000n });
    expect(calculations.accountLiquidity(input)).toMatchObject({ status: "available", currencyCode: "EUR",
      aggregate: { amountMinor: 60000n, limitingDate: "2026-10-08" },
      accounts: [ { accountId: "checking", amountMinor: -40000n, shortfallMinor: 40000n,
        limitingDate: "2026-10-08", firstShortfallDate: "2026-10-08", supportingEvents: [input.events[0]] },
        { accountId: "savings", amountMinor: 100000n, shortfallMinor: 0n } ],
    });
  });
  it.each([ ["2026-10-08", 0n], ["2026-10-09", 40000n] ])("only timely paired funding resolves the gap (%s)", (date, shortfallMinor) => {
    const scenarioEvents = calculations.internalFundingEvents({ date, fromAccountId: "savings", toAccountId: "checking", amountMinor: 40000n });
    expect(scenarioEvents.reduce((sum, event) => sum + event.expectedMinor, 0n)).toBe(0n);
    expect(calculations.accountLiquidity({ ...input, scenarioEvents })).toMatchObject({
      aggregate: { amountMinor: 60000n }, accounts: [{ accountId: "checking", shortfallMinor }, { accountId: "savings" }],
    });
    expect(input.accounts[0].balanceMinor).toBe(10000n);
  });
  it("retains reservations, minimums and pending holds on their own accounts", () => {
    const result = calculations.accountLiquidity({ ...input, accounts: [
      { ...input.accounts[0], availableMinor: 9000n, pendingHoldMinor: 1000n, minimumMinor: 2000n },
      { ...input.accounts[1], reservedMinor: 30000n, safetyBufferMinor: 1000n },
    ] });
    expect(result).toMatchObject({ accounts: [
      { accountId: "checking", amountMinor: -43000n, protectedMinor: 2000n },
      { accountId: "savings", amountMinor: 69000n, protectedMinor: 31000n },
    ] });
  });
  it("does not infer FX or accept invalid funding", () => {
    expect(calculations.accountLiquidity({ ...input, accounts: [{ ...input.accounts[0], currencyCode: "USD" }] })).toEqual({ status: "unavailable", missingInputs: ["fx:checking"] });
    expect(() => calculations.internalFundingEvents({ date: "2026-02-30", fromAccountId: "savings", toAccountId: "checking", amountMinor: 1n })).toThrow();
    expect(() => calculations.internalFundingEvents({ date: input.startDate, fromAccountId: "checking", toAccountId: "checking", amountMinor: 1n })).toThrow();
  });
});
