import { expect, it } from "vitest";
import { enforceUsageBudget, executeFinanceTool, runChat } from "./ai-chat";
const source = {
  accounts: [{ id: "a", name: "Cash", currencyCode: "EUR", balanceMinor: null }],
  transactions: [
    {
      id: "t",
      accountId: "a",
      currencyCode: "EUR",
      direction: "debit" as const,
      amountMinor: "1234",
      effectiveDate: "2026-08-03",
      description: "Restaurant",
      category: "Restaurants",
      counterparty: "Restaurant",
    },
  ],
  dataCutoff: "2026-09-13",
};
it("rejects scope injection and executes exact finance queries", () => {
  expect(() =>
    executeFinanceTool(
      "analytics_cashflow",
      { workspaceId: "foreign", dateFrom: "2026-08-01", dateTo: "2026-08-31", currencyCode: "EUR" },
      source,
    ),
  ).toThrow();
  expect(
    executeFinanceTool(
      "analytics_cashflow",
      { dateFrom: "2026-08-01", dateTo: "2026-08-31", currencyCode: "EUR" },
      source,
    ),
  ).toMatchObject({ result: { spendingMinor: "1234" } });
  expect(() => executeFinanceTool("sql", {}, source)).toThrow();
  expect(() =>
    executeFinanceTool(
      "analytics_cashflow",
      { dateFrom: "2026-99-99", dateTo: "2026-08-31", currencyCode: "EUR" },
      source,
    ),
  ).toThrow();
});
it("does not invoke a provider after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runChat({ signal: controller.signal } as Parameters<typeof runChat>[0]),
  ).rejects.toThrow();
});

it("stops a run when cumulative model cost exceeds its budget", () => {
  const budget = { maxOutputTokens: 100, maxCostMicros: 10 };
  const first = enforceUsageBudget(
    { outputTokens: 0, costMicros: 0 },
    { outputTokens: 2, costMicros: 6 },
    budget,
  );
  expect(first).toEqual({ outputTokens: 2, costMicros: 6 });
  expect(() => enforceUsageBudget(first, { outputTokens: 2, costMicros: 6 }, budget)).toThrow(
    "AI usage budget reached",
  );
});
