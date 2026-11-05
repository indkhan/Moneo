import { expect, it } from "vitest";
import { defaultedChoices, parseInvestigationParams, periodProblem } from "./input";
it("names what is wrong with a period in words", () => {
  expect(periodProblem({ from: "2026-02-30", to: "2026-03-01" })).toBe("From isn’t a real date. Use year, month and day.");
  expect(periodProblem({ from: "2026-03-02", to: "2026-03-01" })).toBe("From must be on or before To.");
  expect(periodProblem({ from: "2026-03-01", to: "2026-03-02", comparisonFrom: "2026-02-01" })).toBe("A comparison needs both Compare from and Compare to.");
  expect(periodProblem({ comparisonFrom: "2026-02-03", comparisonTo: "2026-02-01" })).toBe("Compare from must be on or before Compare to.");
});
it("reports only a submitted form that left a group unticked", () => {
  expect(defaultedChoices({ from: "2026-03-01" })).toEqual([]);
  expect(defaultedChoices({ metric: "spending", kinds: "refund" })).toEqual(["Posted is used because no status was ticked"]);
});
const fallback = { from: "2026-09-01", to: "2026-09-30" };
it("preserves visible dates, tag/event exclusions and multiple grouping dimensions", () => {
  const query = parseInvestigationParams({ comparisonFrom: "2026-08-01", comparisonTo: "2026-08-31", tags: "food, weekly", excludeEvents: "Berlin trip", groupBy: ["category", "merchant"] }, fallback);
  expect(query.tags?.include).toEqual(["food", "weekly"]);
  expect(query.events?.exclude).toEqual(["Berlin trip"]);
  expect(query.comparison).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  expect(query.groupBy).toEqual(["category", "merchant"]);
  expect(parseInvestigationParams({ query: JSON.stringify(query) }, fallback)).toEqual(query);
});
