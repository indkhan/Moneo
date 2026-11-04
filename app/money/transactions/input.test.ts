import { describe, expect, it } from "vitest";
import { amountBounds, bulkInput, directedAmount, parseManualAmount, shownBounds, splitInput } from "./input";

describe("plain amounts with a direction", () => {
  it("signs a positive amount by direction and refuses a minus sign", () => {
    expect(directedAmount("12.34", "out", "EUR")).toBe(-1234n);
    expect(directedAmount("12.34", "in", "EUR")).toBe(1234n);
    expect(directedAmount("25", "out", "JPY")).toBe(-25n);
    expect(() => directedAmount("-12.34", "out", "EUR")).toThrow(/minus/);
  });
  it("turns 10 to 50 money out into the signed range and back", () => {
    const { minAmount, maxAmount } = amountBounds("outflow", "10", "50", "EUR");
    expect([minAmount, maxAmount]).toEqual([-5000n, -1000n]);
    expect(shownBounds("outflow", "-5000", "-1000")).toEqual({ from: "1000", to: "5000" });
    expect(amountBounds("outflow", "", "50", "EUR")).toEqual({ minAmount: -5000n, maxAmount: undefined });
    expect(amountBounds("outflow", "10", "", "EUR")).toEqual({ minAmount: undefined, maxAmount: -1000n });
  });
  it("keeps money in positive and undirected amounts signed as typed", () => {
    expect(amountBounds("income", "10", "50", "EUR")).toEqual({ minAmount: 1000n, maxAmount: 5000n });
    expect(amountBounds("", "-50", "-10", "EUR")).toEqual({ minAmount: -5000n, maxAmount: -1000n });
    expect(shownBounds(undefined, "-5000", "-1000")).toEqual({ from: "-5000", to: "-1000" });
  });
});

describe("manual and bulk transaction inputs", () => {
  it("preserves large exact money and currency precision without interpreting ambiguous separators", () => {
    expect(parseManualAmount("-90071992547409.93", "EUR")).toBe(-9007199254740993n);
    expect(parseManualAmount("25", "JPY")).toBe(25n);
    expect(parseManualAmount("1.234", "KWD")).toBe(1234n);
    for (const value of ["1,000", "1.234", "1e3", "--1", "", "92233720368547758.08"]) {
      expect(() => parseManualAmount(value, "EUR")).toThrow();
    }
  });
  it("requires a reviewed bounded selection with versions and validated metadata", () => {
    const base = { rows: [{ id: "00000000-0000-4000-8000-000000000001", version: 0 }], requestId: "00000000-0000-4000-8000-000000000002", confirmed: "true", mode: "tags", value: "Trip, weekend, trip" };
    expect(bulkInput(base)).toMatchObject({ patch: { tags: ["trip", "weekend"] } });
    expect(() => bulkInput({ ...base, confirmed: "false" })).toThrow();
    expect(() => bulkInput({ ...base, rows: [base.rows[0], base.rows[0]] })).toThrow();
    expect(() => bulkInput({ ...base, rows: [] })).toThrow();
    expect(() => bulkInput({ ...base, mode: "amount", value: "100" })).toThrow();
  });
  it("accepts reviewed merchant assignments and clearing through the existing bounded metadata contract", () => {
    const base = { rows: [{ id: "00000000-0000-4000-8000-000000000001", version: 3 }], requestId: "00000000-0000-4000-8000-000000000002", confirmed: "true", mode: "merchant", value: "00000000-0000-4000-8000-000000000003" };
    expect(bulkInput(base)).toEqual({ rows: base.rows, requestId: base.requestId, patch: { merchant_id: base.value } });
    expect(bulkInput({ ...base, value: "" }).patch).toEqual({ merchant_id: null });
    expect(() => bulkInput({ ...base, value: "Invented merchant" })).toThrow();
    expect(() => bulkInput({ ...base, confirmed: "false" })).toThrow();
    expect(() => bulkInput({ ...base, rows: [base.rows[0], base.rows[0]] })).toThrow();
  });
  it("requires exact same-direction allocations without changing the parent currency or total", () => {
    const rows = [{ amount: "-90071992547400.00", categoryId: null, note: "Food" }, { amount: "-9.93", categoryId: null, note: "Other" }];
    expect(splitInput(rows, "EUR", -9007199254740993n)).toEqual([
      { amount_minor: "-9007199254740000", category_id: null, note: "Food" }, { amount_minor: "-993", category_id: null, note: "Other" },
    ]);
    expect(() => splitInput(rows, "EUR", -1n)).toThrow();
    expect(() => splitInput([{ amount: "1", categoryId: null, note: "" }, { amount: "-2", categoryId: null, note: "" }], "EUR", -100n)).toThrow();
    expect(() => splitInput([{ amount: "0", categoryId: null, note: "" }, { amount: "-1", categoryId: null, note: "" }], "EUR", -100n)).toThrow();
  });
});
