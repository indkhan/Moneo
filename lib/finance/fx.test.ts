import { describe, expect, it } from "vitest";
import { convertFx } from "./fx";

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
    expect(convertFx({ amountMinor: 100n, from: "CHF", to: "EUR", rate: "1", source: "ecb", date: "2026-09-25" }))
      .toEqual({ status: "unavailable", missingInputs: ["currency:CHF"], amountMinor: 100n, currencyCode: "CHF" });
    expect(convertFx({ amountMinor: 100n, from: "JPY", to: "CHF", rate: "1", source: "ecb", date: "2026-09-25" }))
      .toEqual({ status: "unavailable", missingInputs: ["currency:CHF"], amountMinor: 100n, currencyCode: "JPY" });
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
});
