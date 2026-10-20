import { describe, expect, it } from "vitest";
import { readableToolOutput, toolOutputPreview } from "./tool-output";

describe("toolOutputPreview", () => {
  it("leaves out internal fields", () => {
    expect(JSON.parse(toolOutputPreview({ total: "100", calculationEvidence: { a: 1 }, nested: { workspace_id: "w", name: "x" } })))
      .toEqual({ total: "100", nested: { name: "x" } });
  });
  it("caps long output", () => {
    const shown = toolOutputPreview({ rows: "x".repeat(5000) });
    expect(shown.length).toBeLessThan(2100);
    expect(shown.endsWith("… (truncated)")).toBe(true);
  });
  it("handles undefined", () => { expect(toolOutputPreview(undefined)).toBe(""); });
});

describe("readableToolOutput", () => {
  it("adds formatted amounts and owned names while keeping exact minor units", () => {
    const names = { account: new Map([["a1", "Checking"]]), category: new Map([["c1", "Groceries"]]) };
    expect(readableToolOutput({ calculationEvidence: {}, currencyCode: "EUR", spendingMinor: "-12345", netWorth: { USD: "100" },
      rows: [{ account_id: "a1", category_id: "c1", merchant_id: "m1", amount_minor: "-500", currency_code: "JPY" }], dimensions: { category: "c1" } }, names)).toEqual({
      currencyCode: "EUR", spendingMinor: "-12345", spendingFormatted: "-EUR 123.45", netWorth: { USD: "100" }, netWorthFormatted: { USD: "USD 1.00" },
      rows: [{ account_id: "a1", account_name: "Checking", category_id: "c1", category_name: "Groceries", merchant_id: "m1", amount_minor: "-500", amount_formatted: "-JPY 500", currency_code: "JPY" }],
      dimensions: { category: "c1", categoryName: "Groceries" },
    });
  });
  it("leaves amounts without a currency unformatted", () => {
    expect(readableToolOutput({ amountMinor: "100" })).toEqual({ amountMinor: "100" });
  });
});
