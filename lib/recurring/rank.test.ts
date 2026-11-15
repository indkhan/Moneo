import { expect, it, vi } from "vitest";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), cache: <T,>(fn: T) => fn }));
const { rankSuggestions } = await import("./suggestions");

const suggestion = (label: string, low: bigint, high: bigint, occurrences = 3) => ({ series: { label, currencyCode: "EUR", occurrences, amountMinMinor: low, amountMaxMinor: high } });

it("leads with one steady suggestion per merchant and keeps the rest under Less likely", () => {
  const rent = suggestion("Rent", -90000n, -90000n, 12);
  const weekly = suggestion("ALDI SUED", -2000n, -2000n, 3), monthly = suggestion("aldi sued", -2000n, -2000n, 4);
  const groceries = suggestion("Rewe", -9000n, -1500n, 20);
  const { likely, lessLikely } = rankSuggestions([groceries, weekly, rent, monthly]);
  expect(likely).toEqual([rent, monthly]);
  expect(lessLikely).toEqual(expect.arrayContaining([weekly, groceries]));
  expect(lessLikely).toHaveLength(2);
});

it("does not call a small price change unlikely", () => {
  const gym = suggestion("Gym", -3300n, -3000n, 6);
  expect(rankSuggestions([gym]).likely).toEqual([gym]);
});
