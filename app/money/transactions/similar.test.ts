import { expect, it } from "vitest";
import { similarRows } from "./similar";

const rows = [
  { id: "b", version: 1, description: "NETTO Marken-Discount", category_id: null },
  { id: "c", version: 1, description: "Netto Marken-Discount", category_id: "groceries" },
  { id: "d", version: 1, description: "Netto Marken-Discount Online", category_id: null },
];
const filters: string[] = [];
const chain = { select: () => chain, eq: () => chain, neq: () => chain, limit: async () => ({ data: rows, error: null }),
  ilike: (_: string, pattern: string) => { filters.push(pattern); return chain; } };
const supabase = { from: () => chain } as never;

it("finds rows with the same description key in another category, prefiltered by its longest word", async () => {
  const result = await similarRows(supabase, "ws", { id: "a", description: "Netto Marken-Discount", category_id: "groceries" });
  expect(result.rows.map(row => row.id)).toEqual(["b"]);
  expect(filters).toEqual(["%discount%"]);
});

it("offers nothing for an uncategorized row", async () => {
  expect((await similarRows(supabase, "ws", { id: "a", description: "Netto Marken-Discount", category_id: null })).rows).toEqual([]);
});
