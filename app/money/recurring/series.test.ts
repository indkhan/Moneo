import { describe, expect, it } from "vitest";
import { confidenceToPercent, formatMoney, normalizeLabel, seriesKey } from "./series";
import { priceChanges } from "./suggestions";

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

it("converts cadences to an exact monthly equivalent", async () => {
  const { monthlyEquivalent } = await import("./series");
  expect(monthlyEquivalent(-1000n, "monthly")).toBe(-1000n);
  expect(monthlyEquivalent(-1000n, "weekly")).toBe(-4333n);
  expect(monthlyEquivalent(-1000n, "biweekly")).toBe(-2167n);
  expect(monthlyEquivalent(3000n, "quarterly")).toBe(1000n);
  expect(monthlyEquivalent(-11999n, "yearly")).toBe(-1000n);
});

it("flags a confirmed schedule only when a charge newer than its evidence differs in amount", () => {
  const schedule = { id: "a", name: "Netflix", amount_minor: "-1299", cadence: "monthly", starts_on: "2026-09-03", source: "recurring_confirmed", confirmed: true, enabled: true, removed_at: null, category: null };
  const row = (id: string, amount: string) => ({ id, posted_on: `2026-${id}-03`, amount_minor: amount }) as never;
  const item = (latest: string, linked: string[]) => ({ status: "confirmed", assumption: schedule, related: [{ recurring_series_transactions: linked.map(transaction_id => ({ transaction_id })) }],
    evidence: [row("07", "-1299"), row("08", "-1299"), row("09", "-1299"), row("10", latest)] }) as never;
  expect(priceChanges([item("-1399", ["07", "08", "09"])])).toHaveLength(1);
  expect(priceChanges([item("-1299", ["07", "08", "09"])])).toHaveLength(0);
  expect(priceChanges([item("-1399", ["07", "08", "09", "10"])])).toHaveLength(0);
});
