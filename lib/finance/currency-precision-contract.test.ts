import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { minorDigits } from "./fx";

it("keeps the shared SQL accounting-unit map aligned with exact application parsing", () => {
  const source = readFileSync("supabase/migrations/202610010040_accounting_currency_precision.sql", "utf8");
  const match = source.match(/'(\{[^\n]+\})'::jsonb/)!;
  const database = JSON.parse(match[1]) as Record<string, number>;
  expect(Object.keys(database).length).toBeGreaterThan(160);
  for (const [currency, digits] of Object.entries(database)) expect(minorDigits(currency), currency).toBe(digits);
  expect(() => minorDigits("ZZZ")).toThrow("Invalid currency");
});
