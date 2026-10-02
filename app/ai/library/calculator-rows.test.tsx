import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalculatorRows } from "./calculator-rows";

it("renders escaped financial rows as a table with exact currency amounts", () => {
  const html = renderToStaticMarkup(<CalculatorRows currency="EUR" rows={[
    { account: "<script>unsafe</script>", spendingMinor: "9007199254740993", partial: true },
  ]} />);
  expect(html).toContain("<table");
  expect(html).toContain("EUR 90071992547409.93");
  expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});
