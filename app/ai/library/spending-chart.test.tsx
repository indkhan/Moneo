import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SpendingChart } from "./spending-chart";

vi.mock("next/dynamic", () => ({ default: () => (props: { option: unknown }) => <pre>{JSON.stringify(props.option)}</pre> }));

it("charts exact same-currency daily net spending, including refunds and zero days", () => {
  const html = renderToStaticMarkup(<SpendingChart rows={[
    { posted_on: "2026-09-01", amount_minor: "-1000", kind: "ordinary" },
    { posted_on: "2026-09-03", amount_minor: "200", kind: "refund" },
  ]} from="2026-09-01" to="2026-09-03" currency="EUR" />);
  expect(html).toContain("10,0,-2");
  expect(html).toContain('&quot;name&quot;:&quot;EUR&quot;');
  expect(html).toContain("2026-09-02");
});
