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

it("renders app-written charts with filtered transaction links and ignores invalid chart blocks", () => {
  const chart = { currency: "EUR", rows: [{ label: "Income · 2026-09-01 to 2026-09-30", valueMinor: "5000", href: "/money/transactions?from=2026-09-01&to=2026-09-30&direction=income" }, { label: "Spending · 2026-09-01 to 2026-09-30", valueMinor: "1250" }] };
  const html = renderToStaticMarkup(<AiMessage content={`\`\`\`moneo-chart\n${JSON.stringify(chart)}\n\`\`\`\n\n/money/transactions?category=00000000-0000-4000-8000-000000000002`} />);
  expect(html).toContain("ai-chart");
  expect(html).toContain('href="/money/transactions?from=2026-09-01&amp;to=2026-09-30&amp;direction=income"');
  expect(html).toContain("width:100%");
  expect(html).toContain("Open matching transactions");
  const invalid = renderToStaticMarkup(<AiMessage content={'```moneo-chart\n{"currency":"EUR","rows":[{"label":"x","valueMinor":"1","href":"https://evil.test"},{"label":"y","valueMinor":"2"}]}\n```'} />);
  expect(invalid).not.toContain("evil.test");
  expect(invalid).not.toContain("ai-chart");
});

it("keeps untrusted model output inert, including image tracking and unsafe links", () => {
  const html = renderToStaticMarkup(<AiMessage content={'<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n![track](https://example.com/pixel)\n\n```sql\n/money/transactions?transaction=00000000-0000-4000-8000-000000000001\n```'} />);
  expect(html).not.toContain("<script");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("Open transaction and Undo");
});

it("renders model chart blocks, falls back to code when invalid and never links off the app", () => {
  const spec = { title: { text: "Spending by month" }, xAxis: { type: "category", data: ["Aug", "Sep"] }, yAxis: {}, series: [{ type: "bar", data: [1, 2] }] };
  const html = renderToStaticMarkup(<AiMessage content={`\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\`\n\n[site](https://example.com) and [tx](/money/transactions)`} />);
  expect(html).toContain("ai-chart");
  expect(html).toContain("Spending by month");
  expect(html).not.toContain("example.com");
  expect(html).toContain('href="/money/transactions"');
  const invalid = renderToStaticMarkup(<AiMessage content={'```chart\n{"type": not json\n```'} />);
  expect(invalid).not.toContain("ai-chart");
  expect(invalid).toContain("ai-code");
});
