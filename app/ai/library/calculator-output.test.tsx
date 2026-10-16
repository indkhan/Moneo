import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalculatorOutputView, type CalculatorOutput } from "./calculator-output";
import { outputLabel } from "./calculator-rows";

vi.mock("next/dynamic", () => ({ default: () => (props: { ariaLabel: string; type: string }) => <div data-chart={props.type}>{props.ariaLabel}</div> }));

it("renders exact money tiles with readable labels and an escaped summary", () => {
  const output: CalculatorOutput = { summary: "<b>53%</b> used", numbers: { remainingMinor: "9007199254740993", budgetUsed: "53.3%" }, chart: { labels: ["a"], values: [1], type: "line", label: "Cumulative" } };
  const html = renderToStaticMarkup(<CalculatorOutputView output={output} currency="EUR" />);
  expect(html).toContain("EUR 90071992547409.93");
  expect(html).toContain(">Remaining<");
  expect(html).toContain(">Budget used<");
  expect(html).toContain("&lt;b&gt;53%&lt;/b&gt;");
  expect(html).toContain('data-chart="line"');
});

it("uses an output-declared currency for amounts and hides it as a tile", () => {
  const html = renderToStaticMarkup(<CalculatorOutputView output={{ numbers: { yearlyEstimateMinor: "1200", currency: "USD" } }} currency="EUR" />);
  expect(html).toContain("USD 12.00");
  expect(html).not.toContain(">Currency<");
});

it.each([["averageMinorPerDay", "Average per day"], ["spendingLimitForTargetMinor", "Spending limit for target"], ["amount_minor", "Amount"], ["x", "X"]])("labels %s as %s", (key, label) => {
  expect(outputLabel(key)).toBe(label);
});
