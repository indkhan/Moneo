import { describe, expect, it } from "vitest";
import { bulkInput, parseManualAmount } from "./input";

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
});
