import { expect, it } from "vitest";
import { calculatorExportText, calculatorPngLines } from "./export";
import { buildSourceCoverage } from "@/lib/finance/source-coverage";

it("exports the same scoped source limitations and exact accepted-record amounts", () => {
  const sourceCoverage = buildSourceCoverage({ from: "2026-09-01", to: "2026-09-30", currencyCode: "EUR", accountId: "synthetic" }, [], [{ id: "i", status: "failed", total_rows: 2 }], [{ import_id: "i", status: "review", posted_on: "2026-09-02", currency_code: "EUR", account_id: "synthetic" }]);
  const text = calculatorExportText("Spending", "v1", { amountMinor: "9007199254740993" }, {}, { sourceCoverage });
  expect(text).toContain('"amountMinor": "9007199254740993"');
  expect(text).toContain("unresolvedSourceRows: 1");
  expect(text).toContain("unobservedWorkspaceSourceRows: 1");
  expect(text).toContain("statementIntervals: Unknown");
  expect(text).toContain("totalsAreBounds: false");
  expect(text).toContain("selected_account");
});

it("exports exact result text with dated partial evidence and treats markup as literal text", () => {
  const text = calculatorExportText("Comparison", "v3", { summary: "<script>literal</script>", numbers: { amount: "9007199254740993" } }, { months: 3 },
    { partial: true, balances: [{ amount_minor: null, snapshot_amount_minor: "9007199254740993", as_of: "2026-09-01T00:00:00Z", status: "stale" }] });
  expect(text).toContain('"amount": "9007199254740993"'); expect(text).toContain("2026-09-01T00:00:00Z");
  expect(text).toContain("Partial data"); expect(text).toContain('"status": "stale"'); expect(text).toContain("<script>literal</script>");
});

it("renders dated exact currency values and leaves unknown current balances explicit", () => {
  const text = calculatorExportText("Balances", "v1", {}, {}, { balances: [{ name: "Cash", currency_code: "EUR", balance: { amount_minor: null, snapshot_amount_minor: "9007199254740993", as_of: "2026-09-01", status: "stale" } }] });
  expect(text).toContain("snapshot_amount_minor: EUR 90071992547409.93");
  expect(text).toContain("amount_minor: Unknown");
});

it("refuses an oversized image instead of allocating an unsupported canvas", () => {
  expect(() => calculatorPngLines("x".repeat(1000000))).toThrow("Use Print / PDF");
  expect(calculatorPngLines("Readable report")).toEqual(["Readable report"]);
});
it("localizes readable exact evidence while retaining the decimal audit appendix", () => {
  const text = calculatorExportText("Balances", "v1", {}, {}, { currency: "EUR", amount_minor: "9007199254740993" }, "de-DE");
  expect(text).toContain("EUR 90071992547409,93");
  expect(text).toContain('"amount_minor": "9007199254740993"');
});
