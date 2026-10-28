import { beforeEach, expect, it, vi } from "vitest";

const writes: unknown[] = [];
const saved: string[] | null = ["overview", "accounts", "history"];
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {} }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w" }, supabase: { from: () => {
  const query = {
    select: () => query, eq: () => query,
    maybeSingle: async () => ({ data: saved ? { items: saved, version: 3 } : null, error: null }),
    update: (row: unknown) => { writes.push(row); return query; },
    insert: (row: unknown) => { writes.push(row); return { select: () => ({ single: async () => ({ data: { version: 1 }, error: null }) }) }; },
  };
  return query;
} } }) }));

const { moveDashboardWidgets } = await import("./dashboard-actions");
beforeEach(() => { writes.length = 0; });

it("saves a dragged order of the widgets already on Home", async () => {
  await moveDashboardWidgets(3, ["accounts", "overview", "history"]);
  expect(writes).toEqual([expect.objectContaining({ items: ["accounts", "overview", "history"], version: 4 })]);
});

it("refuses to add widgets that are not on Home", async () => {
  await expect(moveDashboardWidgets(3, ["accounts", "goals"])).rejects.toThrow("Dashboard changed");
  expect(writes).toEqual([]);
});
