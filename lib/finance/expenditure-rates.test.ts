import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadExpenditureRates } from "./expenditure-rates";

it("pages exact dated rate identities under workspace, reporting currency and period filters", async () => {
  const calls: unknown[][] = [];
  const rows = Array.from({ length: 501 }, (_, index) => ({ id: `synthetic-${index}`, from_currency: "USD", to_currency: "EUR", rate_text: "0.905", rate_date: "2026-10-07", source: "synthetic" }));
  const query = { select: (columns: string) => { calls.push(["select", columns]); return query; }, eq: (key: string, value: string) => { calls.push(["eq", key, value]); return query; }, gte: (key: string, value: string) => { calls.push(["gte", key, value]); return query; }, lte: (key: string, value: string) => { calls.push(["lte", key, value]); return query; }, order: () => query, range: async (from: number, to: number) => { calls.push(["range", from, to]); return { data: rows.slice(from, to + 1), error: null }; } };
  const db = { from: (table: string) => { calls.push(["from", table]); return query; } } as unknown as SupabaseClient;
  const result = await loadExpenditureRates(db, "synthetic-workspace", { currencyCode: "EUR", from: "2026-10-01", to: "2026-10-07" });
  expect(result).toHaveLength(501);
  expect(result[500]).toEqual({ id: "synthetic-500", fromCurrency: "USD", toCurrency: "EUR", rateText: "0.905", rateDate: "2026-10-07", source: "synthetic" });
  for (const call of [["eq", "workspace_id", "synthetic-workspace"], ["eq", "to_currency", "EUR"], ["gte", "rate_date", "2026-10-01"], ["lte", "rate_date", "2026-10-07"], ["range", 500, 999]]) expect(calls).toContainEqual(call);
});
it("propagates a rate read failure rather than guessing conversion evidence", async () => {
  const error = new Error("synthetic-rate-read-failure");
  const query = { select: () => query, eq: () => query, gte: () => query, lte: () => query, order: () => query, range: async () => ({ data: null, error }) };
  await expect(loadExpenditureRates({ from: () => query } as unknown as SupabaseClient, "w", { currencyCode: "EUR", from: "2026-10-01", to: "2026-10-07" })).rejects.toBe(error);
});
