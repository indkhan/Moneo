import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AiMessage } from "./ai-message";

it("renders structured answers, code and existing source/artifact links", () => {
  const html = renderToStaticMarkup(<AiMessage content={'## Spending\n\n**EUR 420**\n\n| Category | Amount |\n| --- | --- |\n| Dining | EUR 420 |\n\n```sql\nSELECT amount_minor FROM transactions;\n```\n\n/ai/library/00000000-0000-4000-8000-000000000001\n\n/money/transactions?transaction=00000000-0000-4000-8000-000000000002'} />);
  expect(html).toContain("<h2>Spending</h2>");
  expect(html).toContain("<strong>EUR 420</strong>");
  expect(html).toContain("<table>");
  expect(html).toContain('class="language-sql"');
  expect(html).toContain("Open saved tool");
  expect(html).toContain("Open transaction and Undo");
});

it("keeps untrusted model output inert, including image tracking and unsafe links", () => {
  const html = renderToStaticMarkup(<AiMessage content={'<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n![track](https://example.com/pixel)\n\n```sql\n/ai/library/00000000-0000-4000-8000-000000000001\n```'} />);
  expect(html).not.toContain("<script");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("Open saved tool");
});
