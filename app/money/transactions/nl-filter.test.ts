import { expect, it } from "vitest";
import { compileFilterQuery } from "./nl-filter";
import { parseTransactionParams } from "./filters";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const options = { today: "2026-10-16", currency: "EUR", accounts: [{ id: id(1), name: "Revolut" }],
  categories: [{ id: id(2), name: "Coffee" }, { id: id(3), name: "Coffee Shops" }, { id: id(4), name: "Groceries" }], merchants: [{ id: id(5), name: "Northstar Market" }] };
const compile = (text: string) => compileFilterQuery(text, options);

it("compiles “coffee over €5 last month” into exact signed minor-unit filters", () => {
  const { params, understood } = compile("coffee over €5 last month");
  expect(params).toEqual({ direction: "outflow", maxAmount: "-500", from: "2026-09-01", to: "2026-09-30", category: id(2) });
  expect(understood).toEqual(["Money out", "Over EUR 5.00", "Last month", "Category: Coffee"]);
  // The result is exactly what the URL filter model accepts.
  expect(parseTransactionParams(params)).toMatchObject({ direction: "outflow", maxAmountMinor: "-500", from: "2026-09-01", to: "2026-09-30", categoryId: id(2) });
});

it("handles income, ranges, months, sorting, grouping and owned names", () => {
  expect(compile("income over 1000 this year").params).toEqual({ direction: "income", minAmount: "100000", from: "2026-01-01", to: "2026-10-16" });
  expect(compile("between 10 and 50.5 eur at northstar market in september").params).toEqual({ direction: "outflow", minAmount: "-5050", maxAmount: "-1000", from: "2026-09-01", to: "2026-09-30", merchant: id(5) });
  expect(compile("biggest coffee shops purchases by merchant").params).toEqual({ direction: "outflow", sort: "amount-asc", group: "merchant", category: id(3) });
  expect(compile("uncategorized revolut pending last 7 days").params).toEqual({ status: "pending", category: "none", account: id(1), from: "2026-10-09", to: "2026-10-16" });
  expect(compile("december").params).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
});

it("keeps unknown words as a description search and never guesses foreign amounts or months inside words", () => {
  expect(compile("netflix #streaming").params).toEqual({ tag: "streaming", q: "netflix" });
  expect(compile("market stall under $20").params).toEqual({ q: "market stall under $20" });
});
