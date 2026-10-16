import { expect, it } from "vitest";
import { orderByGroup, summarizeGroups } from "./grouping";
import { describeChanges, describePatch, kindLabel, statusLabel } from "./labels";

const row = (category_id: string | null, amount_minor: string, currency_code = "EUR", posted_on = "2026-09-01") =>
  ({ category_id, merchant_id: null, posted_on, amount_minor, currency_code });

it("subtotals each group exactly per currency beyond Number precision", () => {
  const groups = summarizeGroups([row("food", "-9007199254740993"), row("food", "-7"), row("food", "100", "USD"), row(null, "5")], "category");
  expect(groups.get("food")).toEqual({ count: 3, totals: { EUR: "-9007199254741000", USD: "100" } });
  expect(groups.get("none")).toEqual({ count: 1, totals: { EUR: "5" } });
  expect([...summarizeGroups([row(null, "1", "EUR", "2026-08-31"), row(null, "2", "EUR", "2026-09-01")], "month").keys()]).toEqual(["2026-08", "2026-09"]);
  expect(summarizeGroups([row(null, "1")], "merchant").get("none")?.count).toBe(1);
});

it("keeps groups together in first-seen order without reordering inside a group", () => {
  const rows = [row("a", "1"), row("b", "2"), row("a", "3"), row(null, "4"), row("b", "5")];
  expect(orderByGroup(rows, "category").map(r => r.amount_minor)).toEqual(["1", "3", "2", "5", "4"]);
});

it("humanizes ledger keys and correction history", () => {
  expect(statusLabel("posted")).toBe("Posted");
  expect(kindLabel("ordinary")).toBe("Regular");
  const names = { categories: { c1: "Groceries", c2: "Dining" }, merchants: { m1: "Cafe" } };
  expect(describeChanges({ category_id: "c1", note: null, version: 1 }, { category_id: "c2", note: "lunch", version: 2, operation: "metadata" }, names))
    .toEqual(["Category: Groceries → Dining", "Note: None → lunch"]);
  expect(describeChanges({ merchant_id: null, tags: [] }, { merchant_id: "m1", tags: ["trip"] }, names)).toEqual(["Merchant: Unknown merchant → Cafe", "Tags: None → trip"]);
  expect(describePatch({ tags: ["qa"], category_id: null }, names)).toBe("Category set to Uncategorized · Tags set to qa");
});
