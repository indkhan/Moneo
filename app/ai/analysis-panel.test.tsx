import {expect, it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {AnalysisPanel} from "./analysis-panel";

it("offers a required review question, optional focus and exact period/comparison controls", () => {
  const html = renderToStaticMarkup(<AnalysisPanel locale="en-GB" timezone="Europe/Berlin" />);
  expect(html).toContain('name="question"');
  expect(html).toContain("What would you like to investigate?");
  expect(html).toContain('name="focus"');
  for (const name of ["from", "to", "comparisonFrom", "comparisonTo"]) expect(html).toContain(`name="${name}"`);
  expect(html).toContain('type="submit"');
  expect(html).toContain("month to date");
});
