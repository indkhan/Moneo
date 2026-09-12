import { describe, expect, it } from "vitest";
import { fromMinorUnits, toMinorUnits } from "@moneo/shared/money";
import { CURRENCIES, minorDigitsFor } from "./currencies.js";

describe("currency metadata", () => {
  it("seeds EUR, JPY and BHD with correct exponents", () => {
    expect(minorDigitsFor("EUR")).toBe(2);
    expect(minorDigitsFor("JPY")).toBe(0);
    expect(minorDigitsFor("BHD")).toBe(3);
  });

  it("covers a full ISO 4217 active set", () => {
    expect(CURRENCIES.length).toBeGreaterThanOrEqual(165);
    const codes = new Set(CURRENCIES.map((c) => c.code));
    expect(codes.size).toBe(CURRENCIES.length);
    for (const required of ["USD", "EUR", "GBP", "JPY", "BHD", "CHF", "BOV", "USN"]) {
      expect(codes.has(required)).toBe(true);
    }
  });

  it("round-trips minor units per currency exponent", () => {
    expect(toMinorUnits("19.99", minorDigitsFor("EUR"))).toBe(1999n);
    expect(fromMinorUnits(1999n, minorDigitsFor("EUR"))).toBe("19.99");
    expect(toMinorUnits("1500", minorDigitsFor("JPY"))).toBe(1500n);
    expect(toMinorUnits("2.500", minorDigitsFor("BHD"))).toBe(2500n);
    // JPY has no minor units: fractional yen must be rejected, not rounded
    expect(() => toMinorUnits("1.5", minorDigitsFor("JPY"))).toThrow();
  });
});
