import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChatChart } from "./chat-chart";

let option: { tooltip: { formatter: (items: { dataIndex: number }[]) => string } } | undefined;
vi.mock("./chart", () => ({
  ReactECharts: ({ option: drawn }: { option: typeof option }) => { option = drawn; return null; },
  useThemeColors: () => ({ brand: "#000", muted: "#000", border: "#000", card: "#fff", input: "#000", output: "#000", out: "#000", foreground: "#000", dark: false, color: () => "#000" }),
}));

const hostile = "<img src=x onerror=alert(1)>";

it("draws a hostile merchant name in chart tooltips as text, not markup", () => {
  renderToStaticMarkup(<ChatChart source={JSON.stringify({
    title: "Spending", unit: { kind: "money", currency: "EUR" }, type: "bar",
    labels: [hostile, "Groceries"], series: [{ name: hostile, values: ["-1250", "-800"] }],
  })} />);
  const html = option!.tooltip.formatter([{ dataIndex: 0 }]);
  const tags = html.match(/<\/?[a-z][a-z0-9]*/gi) ?? [];
  expect(new Set(tags)).toEqual(new Set(["<div", "</div", "<span", "</span"]));
  expect(html).toContain("onerror=");
});
