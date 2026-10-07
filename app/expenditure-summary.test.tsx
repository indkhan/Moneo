import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpenditureSummary } from "./expenditure-summary";
import { reportExpenditure } from "@/lib/finance/expenditure";

it("offers explicit currency views, original subtotals and audited conversion evidence", () => {
  const report = reportExpenditure([{ id: "synthetic", amountMinor: -100n, currencyCode: "USD", postedOn: "2026-10-07", status: "posted", kind: "ordinary" }], [{ id: "synthetic-rate", fromCurrency: "USD", toCurrency: "EUR", rateText: "0.9", rateDate: "2026-10-07", source: "synthetic" }], { view: "base", currencyCode: "EUR", from: "2026-10-01", to: "2026-10-07" });
  const html = renderToStaticMarkup(<ExpenditureSummary report={report} locale="en-GB" />);
  for (const text of ["Base currency", "Original currencies", "Exact posting-date", "half away from zero", "synthetic-rate", "synthetic", "USD", "2026-10-07"]) expect(html).toContain(text);
});
it("calls unavailable-rate totals incomplete and shows separately labelled converted subtotal", () => {
  const report = reportExpenditure([{ id: "synthetic", amountMinor: -100n, currencyCode: "USD", postedOn: "2026-10-07", status: "posted", kind: "ordinary" }], [], { view: "base", currencyCode: "EUR", from: "2026-10-01", to: "2026-10-07" });
  const html = renderToStaticMarkup(<ExpenditureSummary report={report} locale="en-GB" />);
  expect(html).toContain("Incomplete");
  expect(html).toContain("Available converted subtotal");
  expect(html).toContain("missing-rate");
});
