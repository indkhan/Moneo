import { expect, it } from "vitest";
import { calculatorExportText, calculatorPngLines } from "./export";

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
