import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AiMessage } from "./ai-message";

it("renders structured answers, code and existing source links", () => {
  const html = renderToStaticMarkup(<AiMessage content={'## Spending\n\n**EUR 420**\n\n| Category | Amount |\n| --- | --- |\n| Dining | EUR 420 |\n\n```sql\nSELECT amount_minor FROM transactions;\n```\n\n/money/transactions?transaction=00000000-0000-4000-8000-000000000002'} />);
  expect(html).toContain("<h2>Spending</h2>");
  expect(html).toContain("<strong>EUR 420</strong>");
  expect(html).toContain("<table>");
  expect(html).toContain('class="language-sql"');
  expect(html).toContain("Open transaction and Undo");
});

it("renders a bar chart with exact values in a table, and links only to app transactions", () => {
  const chart = { type: "bar", title: "Spending · Oct 19–25", unit: { kind: "money", currency: "EUR" }, labels: ["Mon 19", "Tue 20"], series: [{ name: "Spending", values: ["1250", "0"] }] };
  const html = renderToStaticMarkup(<AiMessage content={`\`\`\`moneo-chart\n${JSON.stringify(chart)}\n\`\`\``} />);
  expect(html).toContain("ai-chart");
  expect(html).toContain("Spending · Oct 19–25");
  expect(html).toContain("EUR 12.50");
  expect(html).toContain("Mon 19");
});

it("renders pie and bubble charts with their shares and links, and keeps untrusted labels inert", () => {
  const pie = { type: "pie", title: "Where it went", unit: { kind: "money", currency: "EUR" }, items: [{ label: "Food", value: "7500", href: "/money/transactions?category=00000000-0000-4000-8000-000000000002" }, { label: "<b>Rent</b>", value: "2500" }] };
  const pieHtml = renderToStaticMarkup(<AiMessage content={`\`\`\`moneo-chart\n${JSON.stringify(pie)}\n\`\`\``} />);
  expect(pieHtml).toContain("75%");
  expect(pieHtml).toContain('href="/money/transactions?category=00000000-0000-4000-8000-000000000002"');
  expect(pieHtml).not.toContain("<b>Rent</b>");
  const bubble = { type: "bubble", title: "Balances", unit: { kind: "money", currency: "EUR" }, items: [{ label: "Cash", value: "11500" }, { label: "Revolut", value: "125000" }, { label: "Savings", value: "4000" }] };
  const bubbleHtml = renderToStaticMarkup(<AiMessage content={`\`\`\`moneo-chart\n${JSON.stringify(bubble)}\n\`\`\``} />);
  expect(bubbleHtml.match(/<circle/g)).toHaveLength(3);
  expect(bubbleHtml).toContain("EUR 1250.00");
});

it("shows a notice instead of a chart for invalid specs, and never links off the app", () => {
  const offApp = { type: "pie", title: "x", unit: { kind: "count" }, items: [{ label: "a", value: "1", href: "https://evil.test" }, { label: "b", value: "2" }] };
  const offAppHtml = renderToStaticMarkup(<AiMessage content={`\`\`\`moneo-chart\n${JSON.stringify(offApp)}\n\`\`\``} />);
  expect(offAppHtml).not.toContain("evil.test");
  expect(offAppHtml).toContain("could not be drawn");
  expect(offAppHtml).not.toContain("ai-chart");
  const mismatched = { type: "line", title: "x", unit: { kind: "count" }, labels: ["a", "b"], series: [{ name: "s", values: ["1"] }] };
  const mismatchedHtml = renderToStaticMarkup(<AiMessage content={`\`\`\`moneo-chart\n${JSON.stringify(mismatched)}\n\`\`\``} />);
  expect(mismatchedHtml).toContain("could not be drawn");
  expect(mismatchedHtml).not.toContain("<code");
});

it("keeps untrusted model output inert, including image tracking and unsafe links", () => {
  const html = renderToStaticMarkup(<AiMessage content={'<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n![track](https://example.com/pixel)\n\n```sql\n/money/transactions?transaction=00000000-0000-4000-8000-000000000001\n```'} />);
  expect(html).not.toContain("<script");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("Open transaction and Undo");
});

it("renders a loan card for an app-written moneo-proposal block and ignores a malformed id", () => {
  const card = renderToStaticMarkup(<AiMessage content={"```moneo-proposal\n00000000-0000-4000-8000-000000000001\n```"} />);
  expect(card).toContain("Loading");
  const bad = renderToStaticMarkup(<AiMessage content={"```moneo-proposal\nnot-an-id\n```"} />);
  expect(bad).not.toContain("Loading");
});

it("groups several proposal cards with an Add all button and ignores invalid groups", () => {
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
  const html = renderToStaticMarkup(<AiMessage content={`Three cards are waiting.\n\n\`\`\`moneo-proposals\n${JSON.stringify(ids)}\n\`\`\``} />);
  expect(html).toContain("Add all 3");
  expect(html.match(/Loading…/g)).toHaveLength(3);
  expect(renderToStaticMarkup(<AiMessage content={'```moneo-proposals\n["not-an-id","x"]\n```'} />)).not.toContain("Add all");
});
