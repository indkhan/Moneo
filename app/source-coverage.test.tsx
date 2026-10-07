import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SourceCoverageDetails } from "./source-coverage";
import { buildSourceCoverage } from "@/lib/finance/source-coverage";

it("shows included and unresolved evidence without implying a complete financial period", () => {
  const coverage = buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02", currencyCode: "EUR" }, [],
    [{ id: "i", status: "failed", total_rows: 1 }], [{ import_id: "i", status: "review", posted_on: "2026-10-01", currency_code: "EUR" }]);
  const html = renderToStaticMarkup(<SourceCoverageDetails coverage={coverage} />);
  expect(html).toContain("1 unresolved source observation");
  expect(html).toContain("failed: 1");
  expect(html).toContain("Statement intervals and full account coverage are unknown");
  expect(html).toContain("Exact included totals are neither upper nor lower bounds");
});
