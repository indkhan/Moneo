import { expect, it } from "vitest";
import { latestPriceChange } from "./price-changes";

const charge = (postedOn: string, amountMinor: bigint, currencyCode = "EUR") => ({ postedOn, amountMinor, currencyCode });

it("compares the two latest charges and ignores unchanged prices or a currency switch", () => {
  expect(latestPriceChange([charge("2026-09-12", -1799n), charge("2026-10-12", -1999n), charge("2026-08-12", -1799n)])).toEqual({ changeMinor: 200n, currencyCode: "EUR", since: "2026-10-12" });
  expect(latestPriceChange([charge("2026-09-12", -1999n), charge("2026-10-12", -1799n)])?.changeMinor).toBe(-200n);
  expect(latestPriceChange([charge("2026-09-12", -1999n), charge("2026-10-12", -1999n)])).toBeNull();
  expect(latestPriceChange([charge("2026-09-12", -1999n, "USD"), charge("2026-10-12", -1799n)])).toBeNull();
  expect(latestPriceChange([charge("2026-10-12", -1999n)])).toBeNull();
});
