// E01-S04 exact-representation goldens (architecture §158). Independently
// computed expectations: decimal strings only, BigInt arithmetic, fiat
// exponents, no floats anywhere. Past safe-integer values must round-trip.

import { describe, expect, it } from "vitest";
import { currencyExponent, formatDecimalBigint, formatMinor, parseDecimalBigint, parseMinor } from "../apps/web/src/money.ts";

describe("e01-s04 money boundary", () => {
  it("parses and formats canonical decimal strings", () => {
    expect(parseDecimalBigint("0")).toBe(0n);
    expect(parseDecimalBigint("3142")).toBe(3142n);
    expect(formatDecimalBigint(3142n)).toBe("3142");
    expect(() => parseDecimalBigint("")).toThrow();
    expect(() => parseDecimalBigint(" 3142")).toThrow();
    expect(() => parseDecimalBigint("3142 ")).toThrow();
    expect(() => parseDecimalBigint("-5")).toThrow();
    expect(() => parseDecimalBigint("007")).toThrow(); // non-canonical
    expect(() => parseDecimalBigint("3.0")).toThrow();
    expect(() => parseDecimalBigint(3142 as unknown as string)).toThrow(); // never a Number
  });

  it("round-trips values past JS safe-integer exactly", () => {
    expect(parseDecimalBigint("9007199254740993")).toBe(9007199254740993n);
    expect(formatDecimalBigint(9007199254740993n)).toBe("9007199254740993");
    expect(parseDecimalBigint("9223372036854775807")).toBe((1n << 63n) - 1n);
    expect(() => parseDecimalBigint("9223372036854775808")).toThrow(); // int64 overflow
    expect(() => formatDecimalBigint(-1n)).toThrow();
  });

  it("applies fiat exponents exactly", () => {
    expect(currencyExponent("EUR")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("XXX")).toBeUndefined();
    expect(parseMinor("31.42", "EUR")).toBe(3142n);
    expect(parseMinor("0.05", "EUR")).toBe(5n);
    expect(parseMinor("100", "JPY")).toBe(100n);
    expect(parseMinor("1.234", "KWD")).toBe(1234n);
    expect(formatMinor(3142n, "EUR")).toBe("31.42");
    expect(formatMinor(5n, "EUR")).toBe("0.05");
    expect(formatMinor(100n, "JPY")).toBe("100");
    expect(formatMinor(1234n, "KWD")).toBe("1.234");
    expect(() => parseMinor("1.234", "EUR")).toThrow(); // excess precision
    expect(() => parseMinor("1.5", "JPY")).toThrow();
    expect(() => parseMinor("abc", "EUR")).toThrow();
  });

  it("keeps float contamination out: 0.1 + 0.2 is not 0.3 in minor units", () => {
    // The classic float trap: computed with Number this would be 0.30000000000000004.
    const exact = parseMinor("0.1", "EUR") + parseMinor("0.2", "EUR");
    expect(exact).toBe(30n);
    expect(formatMinor(exact, "EUR")).toBe("0.30");
  });
});
