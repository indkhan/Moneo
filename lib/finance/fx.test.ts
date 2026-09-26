import { describe, expect, it } from "vitest";
import { convertFx, minorDigits } from "./fx";

describe("minorDigits", () => {
  it("returns correct minor digits for known currencies", () => {
    expect(minorDigits("EUR")).toBe(2);
    expect(minorDigits("USD")).toBe(2);
    expect(minorDigits("GBP")).toBe(2);
    expect(minorDigits("JPY")).toBe(0);
    expect(minorDigits("KRW")).toBe(0);
    expect(minorDigits("KWD")).toBe(3);
  });

  it("normalizes case and whitespace", () => {
    expect(minorDigits("eur")).toBe(2);
    expect(minorDigits("  USD  ")).toBe(2);
    expect(minorDigits("jpy")).toBe(0);
  });

  it("throws for invalid currency codes", () => {
    expect(() => minorDigits("")).toThrow("Invalid currency code");
    expect(() => minorDigits("EU")).toThrow("Invalid currency code");
    expect(() => minorDigits("EURO")).toThrow("Invalid currency code");
    expect(() => minorDigits("123")).toThrow("Invalid currency code");
    expect(() => minorDigits("XXX")).toThrow("Invalid currency code");
  });
});

describe("exact FX conversion", () => {
  it("converts minor units exactly, beyond float precision, preserving source and rate", () => {
    // 9007199254740993 is not representable as a JS number, so any
    // floating-point math would silently corrupt this conversion.
    const result = convertFx({ amountMinor: 9007199254740993n, from: "EUR", to: "USD", rate: "1", source: "ecb", date: "2026-09-25" });
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available");
    expect(result.amountMinor).toBe(9007199254740993n);
    expect(result.currencyCode).toBe("EUR");
    expect(result.converted).toEqual({ amountMinor: 9007199254740993n, currencyCode: "USD" });
    expect(result.rate).toEqual({ numerator: 1n, denominator: 1n });
    expect(result.source).toBe("ecb");
    expect(result.date).toBe("2026-09-25");
  });

  it("applies exact decimal-string rates across different minor digits", () => {
    const eurUsd = convertFx({ amountMinor: 100n, from: "EUR", to: "USD", rate: "1.08", source: "ecb", date: "2026-09-25" });
    if (eurUsd.status !== "available") throw new Error("expected available");
    expect(eurUsd.converted.amountMinor).toBe(108n);
    const jpyEur = convertFx({ amountMinor: 100n, from: "JPY", to: "EUR", rate: "0.0062", source: "ecb", date: "2026-09-25" });
    if (jpyEur.status !== "available") throw new Error("expected available");
    expect(jpyEur.converted.amountMinor).toBe(62n);
    const ratio = convertFx({ amountMinor: 100n, from: "USD", to: "EUR", rate: { numerator: 88n, denominator: 100n }, source: "ecb", date: "2026-09-25" });
    if (ratio.status !== "available") throw new Error("expected available");
    expect(ratio.converted.amountMinor).toBe(88n);
  });

  it("rounds derived minor units half-up, away from zero", () => {
    const cases: Array<[bigint, bigint]> = [
      [1n, 1n], // 0.5 JPY -> 1
      [3n, 2n], // 1.5 JPY -> 2
      [2n, 1n], // exact, no rounding
      [0n, 0n],
      [-1n, -1n], // -0.5 JPY -> -1
      [-3n, -2n], // -1.5 JPY -> -2
    ];
    for (const [amountMinor, expectedMinor] of cases) {
      const result = convertFx({ amountMinor, from: "EUR", to: "JPY", rate: "50", source: "ecb", date: "2026-09-25" });
      if (result.status !== "available") throw new Error("expected available");
      expect(result.converted).toEqual({ amountMinor: expectedMinor, currencyCode: "JPY" });
    }
  });

  it("needs no rate for same-currency amounts", () => {
    const result = convertFx({ amountMinor: 123n, from: "GBP", to: "GBP", rate: undefined, source: "ecb", date: "2026-09-25" });
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available");
    expect(result.converted).toEqual({ amountMinor: 123n, currencyCode: "GBP" });
  });

  it("returns unavailable, keeping the original, when currency or rate metadata is missing", () => {
    expect(convertFx({ amountMinor: 100n, from: "CHF", to: "EUR", rate: undefined, source: "ecb", date: "2026-09-25" }))
      .toEqual({ status: "unavailable", missingInputs: ["rate:CHF->EUR"], amountMinor: 100n, currencyCode: "CHF" });
    expect(convertFx({ amountMinor: 100n, from: "EUR", to: "USD", rate: undefined, source: "ecb", date: "2026-09-25" }))
      .toEqual({ status: "unavailable", missingInputs: ["rate:EUR->USD"], amountMinor: 100n, currencyCode: "EUR" });
  });

  it("rejects inexact or invalid rate and date inputs", () => {
    const base = { amountMinor: 100n, from: "EUR", to: "USD", source: "ecb", date: "2026-09-25" };
    expect(() => convertFx({ ...base, rate: "1.08.1" })).toThrow("Invalid rate");
    expect(() => convertFx({ ...base, rate: { numerator: 1n, denominator: 0n } })).toThrow("Invalid rate");
    expect(() => convertFx({ ...base, rate: "0" })).toThrow("Invalid rate");
    expect(() => convertFx({ ...base, rate: "1", date: "2026-13-01" })).toThrow("Invalid date");
  });

  it("converts KRW (0 digits) and KWD (3 digits) correctly", () => {
    // KRW has 0 minor digits, KWD has 3
    const krwToUsd = convertFx({ amountMinor: 1000n, from: "KRW", to: "USD", rate: "0.00075", source: "ecb", date: "2026-09-25" });
    if (krwToUsd.status !== "available") throw new Error("expected available");
    // 1000 KRW * 0.00075 = 0.75 USD = 75 cents
    expect(krwToUsd.converted.amountMinor).toBe(75n);

    const kwdToUsd = convertFx({ amountMinor: 1000n, from: "KWD", to: "USD", rate: "3.25", source: "ecb", date: "2026-09-25" });
    if (kwdToUsd.status !== "available") throw new Error("expected available");
    // 1.000 KWD * 3.25 = 3.25 USD = 325 cents.
    expect(kwdToUsd.converted.amountMinor).toBe(325n);

    const usdToKrw = convertFx({ amountMinor: 100n, from: "USD", to: "KRW", rate: "1333", source: "ecb", date: "2026-09-25" });
    if (usdToKrw.status !== "available") throw new Error("expected available");
    // 1.00 USD * 1333 = 1333 KRW (0 digits)
    expect(usdToKrw.converted.amountMinor).toBe(1333n);
  });

  it("returns unavailable for unknown currency codes without throwing", () => {
    const result = convertFx({ amountMinor: 100n, from: "XXX", to: "USD", rate: "1", source: "ecb", date: "2026-09-25" });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("expected unavailable");
    expect(result.missingInputs[0]).toBe("currency:XXX");
  });
});
