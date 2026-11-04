import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { minorDigits } from "@/lib/finance/fx";
import { CurrencySelect, currencyCode, currencyOptions, matchCurrencies } from "./currency-select";

const options = currencyOptions("en");

describe("currency picker", () => {
  it("offers only currencies the server accepts, with the usual ones first", () => {
    expect(options[0]).toEqual({ code: "EUR", name: "Euro", label: "EUR · Euro" });
    for (const option of options) expect(() => minorDigits(option.code)).not.toThrow();
    expect(new Set(options.map(option => option.code)).size).toBe(options.length);
  });

  it("finds a currency by name or by code", () => {
    expect(matchCurrencies(options, "japan")[0].code).toBe("JPY");
    expect(matchCurrencies(options, "jpy")[0].code).toBe("JPY");
    expect(matchCurrencies(options, "nothing like this")).toEqual([]);
  });

  it("submits the three-letter code for a chosen option or typed text", () => {
    expect(currencyCode(options, "JPY · Japanese Yen")).toBe("JPY");
    expect(currencyCode(options, " usd ")).toBe("USD");
    expect(currencyCode(options, "xxx")).toBe("XXX");
  });

  it("shows the name and keeps the code as the form value", () => {
    const html = renderToStaticMarkup(<CurrencySelect name="currency" label="Currency" defaultValue="EUR" locale="en" />);
    expect(html).toContain('type="hidden" name="currency" value="EUR"');
    expect(html).toContain('value="EUR · Euro"');
  });
});
