import { describe, expect, it } from "vitest";
import { confidenceToPercent, formatMoney, normalizeLabel, seriesKey } from "./series";

describe("recurring review helpers", () => {
  it("normalizes labels like Postgres (trim, collapse spaces, lowercase)", () => {
    expect(normalizeLabel("  ACME   Rent ")).toBe("acme rent");
    expect(seriesKey({ accountId: "a", currencyCode: "EUR", cadence: "monthly", label: "  ACME Rent " }))
      .toBe(seriesKey({ accountId: "a", currencyCode: "EUR", cadence: "monthly", label: "acme   rent" }));
  });

  it("formats signed minor units without floats", () => {
    expect(formatMoney("-1099", "EUR")).toBe("−EUR 10.99");
    expect(formatMoney(2500n, "USD")).toBe("USD 25.00");
    expect(formatMoney(2500n, "JPY")).toBe("JPY 2500");
    expect(formatMoney("-9007199254740993", "EUR", "de-DE")).toBe("−EUR 90071992547409,93");
  });

  it("maps detector confidence to assumption percent", () => {
    expect(confidenceToPercent(0.7)).toBe(70);
  });
});

it("keeps separate runs of the same merchant and cadence distinct", () => {
  const first = {accountId: "cash", currencyCode: "EUR", cadence: "monthly", label: "Rent", runAnchorId: "first"};
  const second = {...first, runAnchorId: "second"};
  expect(seriesKey(first)).not.toBe(seriesKey(second));
});
