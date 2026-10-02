import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCategoryPreview } from "./edit-preview";
const id = "00000000-0000-4000-8000-000000000001", categoryId = "00000000-0000-4000-8000-000000000002";
it("requires every exact owned target and category, preserves exact amounts and performs no writes", async () => {
  const calls: unknown[][] = [];
  const from = () => {
    const q = { select: () => q, neq: () => q, eq: (...args: unknown[]) => { calls.push(args); return q; }, in: async () => ({ data: [{ id, version: 1, amount_minor: "-9007199254740993", currency_code: "EUR" }], error: null }),
      maybeSingle: async () => ({ data: { id: categoryId, name: "Food" }, error: null }) }; return q;
  };
  const db = { from } as unknown as SupabaseClient;
  const preview = await loadCategoryPreview(db, "workspace", [id], categoryId);
  expect(preview.totals).toEqual({ EUR: "-9007199254740993" });
  expect(preview.category.name).toBe("Food");
  expect(calls).toContainEqual(["workspace_id", "workspace"]);
  await expect(loadCategoryPreview(db, "workspace", [id, "00000000-0000-4000-8000-000000000003"], categoryId)).rejects.toThrow("selection");
  await expect(loadCategoryPreview(db, "workspace", [id, id], categoryId)).rejects.toThrow();
});
