import { expect, it } from "vitest";
import { parseInvestigationParams } from "./input";
const fallback = { from: "2026-09-01", to: "2026-09-30" };
it("preserves visible dates, tag/event exclusions and multiple grouping dimensions", () => {
  const query = parseInvestigationParams({ comparisonFrom: "2026-08-01", comparisonTo: "2026-08-31", tags: "food, weekly", excludeEvents: "Berlin trip", groupBy: ["category", "merchant"] }, fallback);
  expect(query.tags?.include).toEqual(["food", "weekly"]);
  expect(query.events?.exclude).toEqual(["Berlin trip"]);
  expect(query.comparison).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  expect(query.groupBy).toEqual(["category", "merchant"]);
  expect(parseInvestigationParams({ query: JSON.stringify(query) }, fallback)).toEqual(query);
});
