import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chartDatasets, resolveChart } from "./chart-spec";
import { DataQueryError, dataQueryChartDataset, dataQueryInput, dataQueryOutput, dataQuerySchema, runDataQuery, shapeDataQuery } from "./data-query";

describe("data_query input", () => {
  it("takes one bounded query and a row count up to the cap", () => {
    expect(dataQueryInput.parse({ sql: "  select 1  " })).toEqual({ sql: "select 1" });
    for (const input of [{ sql: " " }, { sql: "x".repeat(8001) }, { sql: "select 1", maxRows: 501 }, { sql: "select 1", maxRows: 0 }, { sql: "select 1", role: "service_role" }])
      expect(dataQueryInput.safeParse(input).success).toBe(false);
  });
});

describe("data_query results", () => {
  it("keeps every value when two columns share a name, and keeps exact numbers as text", () => {
    expect(shapeDataQuery({ columns: ["amount_minor", "amount_minor", "currency_code"], rows: [["9007199254740993", "-5", "EUR"]], truncated: null }))
      .toEqual({ columns: ["amount_minor", "amount_minor_2", "currency_code"], rows: [{ amount_minor: "9007199254740993", amount_minor_2: "-5", currency_code: "EUR" }], truncated: null });
  });

  it("turns a rejected query into an error the model can fix", () => {
    expect(() => shapeDataQuery({ error: "column \"amount\" does not exist" })).toThrow(DataQueryError);
  });

  it("says when rows were cut", () => {
    const output = dataQueryOutput({ columns: ["g"], rows: Array.from({ length: 500 }, (_, index) => ({ g: String(index) })), truncated: "rows" });
    expect(output.rowCount).toBe(500);
    expect(output.truncated).toBeDefined();
    expect(dataQueryOutput({ columns: [], rows: [], truncated: null })).not.toHaveProperty("truncated");
  });

  it("asks the database for only the scopes it was given", async () => {
    const rpc = vi.fn(async () => ({ data: { columns: ["n"], rows: [["1"]], truncated: null }, error: null }));
    await runDataQuery({ rpc } as unknown as SupabaseClient, "select 1 n;", ["transactions"]);
    expect(rpc).toHaveBeenCalledWith("data_query", { p_sql: "select 1 n;", p_scopes: ["transactions"], p_max_rows: 500 });
  });
});

it("describes only the tables the AI may read", () => {
  const schema = dataQuerySchema(["transactions"]);
  expect(schema).toContain("transactions:");
  expect(schema).not.toContain("wealth_items");
  expect(schema).not.toContain("accounts:");
});

describe("charting a data_query result", () => {
  it("charts exact amounts in the chart's currency only, and rejects a column the query didn't return", () => {
    const result = shapeDataQuery({ columns: ["month", "spent", "currency_code"], rows: [["2026-09", "9007199254740993", "EUR"], ["2026-09", "500", "USD"], ["2026-10", "1250", "EUR"]], truncated: null });
    const store = chartDatasets();
    const id = store.add(dataQueryChartDataset(result, { month: { kind: "text" }, spent: { kind: "money", currencyColumn: "currency_code" }, currency_code: { kind: "text" } }));
    const chart = resolveChart({ type: "bar", title: "Spending", unit: { kind: "money", currency: "EUR" }, datasetId: id, labels: { column: "month" }, series: [{ name: "Spent", values: { column: "spent" } }] }, store.get);
    expect(chart).toMatchObject({ ok: true, chart: { labels: ["2026-09", "2026-10"], series: [{ values: ["9007199254740993", "1250"] }] } });
    expect(() => dataQueryChartDataset(result, { amount: { kind: "count" } })).toThrow(DataQueryError);
  });
});
