import {expect, it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {AnalysisPanel, datesProblem} from "./analysis-panel";

it("names the first half-filled or reversed date range and accepts blank or valid ones", () => {
  const dates = (values: Record<string, string>) => datesProblem(name => values[name] ?? "");
  expect(dates({})).toBeNull();
  expect(dates({ from: "2026-01-01", to: "2026-01-31" })).toBeNull();
  expect(dates({ from: "2026-01-01" })).toMatchObject({ field: "to" });
  expect(dates({ to: "2026-01-01" })).toMatchObject({ field: "from" });
  expect(dates({ from: "2026-02-01", to: "2026-01-01" })).toMatchObject({ field: "to" });
  expect(dates({ comparisonFrom: "2026-02-01", comparisonTo: "2026-01-01" })?.message).toContain("Compare with");
});

it("offers a required review question, optional focus and exact period/comparison controls", () => {
  const html = renderToStaticMarkup(<AnalysisPanel locale="en-GB" timezone="Europe/Berlin" />);
  expect(html).toContain('name="question"');
  expect(html).toContain("What would you like to investigate?");
  expect(html).toContain('name="focus"');
  for (const name of ["from", "to", "comparisonFrom", "comparisonTo"]) expect(html).toContain(`name="${name}"`);
  expect(html).toContain('type="submit"');
  expect(html).toContain("this month so far");
  expect(html).toContain('name="planning"');
  expect(html).toContain("Planning evidence (optional)");
  expect(html).toContain("7-day forecast");
});
