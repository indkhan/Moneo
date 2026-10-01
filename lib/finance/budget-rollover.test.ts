import { expect, it } from "vitest";
import { rolloverBudget } from "./spending-plans";
it("uses each recorded month's limit, carries overspending, and never applies today's edited limit to past months", () => {
  const tx = [{ amountMinor: -12000n, currencyCode: "EUR", status: "posted", kind: "ordinary", categoryId: "food", postedOn: "2026-09-15" }, { amountMinor: -3000n, currencyCode: "EUR", status: "posted", kind: "ordinary", categoryId: "food", postedOn: "2026-10-01" }];
  const history = [{ effective_month: "2026-09-01", limit_minor: "10000", enabled: true, version: 1 }, { effective_month: "2026-10-01", limit_minor: "20000", enabled: true, version: 2 }];
  expect(rolloverBudget(tx, "food", "EUR", "2026-09", "2026-10", 20000n, history)).toEqual({ status: "available", carriedMinor: -2000n, allowanceMinor: 18000n, spentMinor: 3000n, remainingMinor: 15000n });
  expect(rolloverBudget(tx, "food", "EUR", "2026-08", "2026-10", 20000n, history)).toMatchObject({ status: "unavailable" });
});
it("does not invent carry when an uncategorized historical row still needs financial review", () => {
  const history = [{ effective_month: "2026-09-01", limit_minor: "10000", enabled: true, version: 1 }];
  const tx = [{ amountMinor: -1000n, currencyCode: "EUR", status: "posted", kind: "ordinary", categoryId: null, postedOn: "2026-09-15", reviewReasons: ["unknown_type"] }];
  expect(rolloverBudget(tx, "food", "EUR", "2026-09", "2026-10", 10000n, history)).toMatchObject({ status: "unavailable", missingInput: "Financial classification needs review in 2026-09" });
});
