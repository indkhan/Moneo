import { describe, expect, it } from "vitest";
import {
  formatMoney,
  moneyFromJSON,
  moneyToJSON,
  parseLocalizedAmount,
  type Money,
} from "./money.js";

describe("parseLocalizedAmount", () => {
  it("parses EUR with en-US separators", () => {
    expect(parseLocalizedAmount("1,234.56", { currency: "EUR", locale: "en-US" })).toEqual({
      amountMinor: 123456n,
      currency: "EUR",
      direction: "credit",
    });
  });

  it("parses EUR with de-DE separators", () => {
    expect(parseLocalizedAmount("1.234,56", { currency: "EUR", locale: "de-DE" })).toEqual({
      amountMinor: 123456n,
      currency: "EUR",
      direction: "credit",
    });
  });

  it("parses EUR with fr-FR space grouping, including nbsp variants", () => {
    const expected: Money = { amountMinor: 123456n, currency: "EUR", direction: "credit" };
    expect(parseLocalizedAmount("1 234,56", { currency: "EUR", locale: "fr-FR" })).toEqual(
      expected,
    );
    expect(parseLocalizedAmount("1\u00a0234,56", { currency: "EUR", locale: "fr-FR" })).toEqual(
      expected,
    );
    expect(parseLocalizedAmount("1\u202f234,56", { currency: "EUR", locale: "fr-FR" })).toEqual(
      expected,
    );
  });

  it("handles zero-decimal JPY and three-decimal BHD", () => {
    expect(parseLocalizedAmount("1,500", { currency: "JPY", locale: "en-US" }).amountMinor).toBe(
      1500n,
    );
    expect(parseLocalizedAmount("2,500", { currency: "BHD", locale: "de-DE" }).amountMinor).toBe(
      2500n,
    );
    expect(() => parseLocalizedAmount("1.5", { currency: "JPY", locale: "en-US" })).toThrow();
  });

  it("maps negative input to explicit debit direction", () => {
    expect(parseLocalizedAmount("-1,234.56", { currency: "EUR", locale: "en-US" })).toEqual({
      amountMinor: 123456n,
      currency: "EUR",
      direction: "debit",
    });
    expect(parseLocalizedAmount("(1,234.56)", { currency: "EUR", locale: "en-US" }).direction).toBe(
      "debit",
    );
    expect(parseLocalizedAmount("+1,234.56", { currency: "EUR", locale: "en-US" }).direction).toBe(
      "credit",
    );
    // Zero has no direction; canonicalize to credit.
    expect(parseLocalizedAmount("-0.00", { currency: "EUR", locale: "en-US" })).toEqual({
      amountMinor: 0n,
      currency: "EUR",
      direction: "credit",
    });
  });

  it("strips an explicit currency code but rejects symbols", () => {
    expect(
      parseLocalizedAmount("EUR 1.234,56", { currency: "EUR", locale: "de-DE" }).amountMinor,
    ).toBe(123456n);
    expect(
      parseLocalizedAmount("1.234,56 EUR", { currency: "EUR", locale: "de-DE" }).amountMinor,
    ).toBe(123456n);
    expect(() => parseLocalizedAmount("€1.234,56", { currency: "EUR", locale: "de-DE" })).toThrow();
  });

  it("rejects malformed grouping and ambiguous separators", () => {
    expect(() => parseLocalizedAmount("12,34,56", { currency: "EUR", locale: "en-US" })).toThrow();
    expect(() => parseLocalizedAmount("1.234.56", { currency: "EUR", locale: "de-DE" })).toThrow();
    expect(() => parseLocalizedAmount("1,234,56", { currency: "EUR", locale: "de-DE" })).toThrow();
  });

  it("rejects fractions beyond the currency exponent instead of rounding", () => {
    expect(() => parseLocalizedAmount("1.234", { currency: "EUR", locale: "en-US" })).toThrow();
  });

  it("rejects overflow beyond the safe integer range", () => {
    expect(() =>
      parseLocalizedAmount("99,999,999,999,999,999.00", { currency: "EUR", locale: "en-US" }),
    ).toThrow();
    // Boundary value is accepted.
    expect(
      parseLocalizedAmount("90,071,992,547,409.91", { currency: "EUR", locale: "en-US" })
        .amountMinor,
    ).toBe(9007199254740991n);
  });

  it("rejects unknown currencies and empty input", () => {
    expect(() => parseLocalizedAmount("12.00", { currency: "XXX", locale: "en-US" })).toThrow();
    expect(() => parseLocalizedAmount("   ", { currency: "EUR", locale: "en-US" })).toThrow();
  });
});

describe("formatMoney", () => {
  it("formats deterministically per locale", () => {
    const debit: Money = { amountMinor: 123456n, currency: "EUR", direction: "debit" };
    expect(formatMoney(debit, "en-US")).toBe("-1,234.56 EUR");
    expect(formatMoney(debit, "de-DE")).toBe("-1.234,56 EUR");
    expect(formatMoney({ ...debit, direction: "credit" }, "en-US")).toBe("1,234.56 EUR");
    expect(formatMoney({ amountMinor: 1500n, currency: "JPY", direction: "credit" }, "fr-FR")).toBe(
      "1\u202f500 JPY",
    );
  });
});

describe("money JSON serialization", () => {
  it("round-trips exactly through JSON with string minor units", () => {
    const money: Money = { amountMinor: 123456n, currency: "EUR", direction: "debit" };
    const json = JSON.stringify(moneyToJSON(money));
    expect(json).toBe('{"amount":"123456","currency":"EUR","direction":"debit"}');
    expect(moneyFromJSON(JSON.parse(json))).toEqual(money);
  });

  it("adds minor units exactly, without float error", () => {
    const a = parseLocalizedAmount("0.10", { currency: "EUR", locale: "en-US" });
    const b = parseLocalizedAmount("0.20", { currency: "EUR", locale: "en-US" });
    expect(a.amountMinor + b.amountMinor).toBe(30n);
  });

  it("rejects non-canonical JSON payloads", () => {
    expect(() => moneyFromJSON({ amount: 1234, currency: "EUR", direction: "credit" })).toThrow();
    expect(() => moneyFromJSON({ amount: "-5", currency: "EUR", direction: "credit" })).toThrow();
    expect(() => moneyFromJSON({ amount: "12", currency: "XX", direction: "credit" })).toThrow();
  });
});
