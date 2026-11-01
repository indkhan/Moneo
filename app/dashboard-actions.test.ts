import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ writes: [] as { op: string; values: Record<string, unknown>; version?: unknown }[], result: { data: { version: 4 } as unknown, error: null as unknown } }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "workspace" }, supabase: { from: () => {
  let write: (typeof fixture.writes)[number];
  const query = {
    insert: (values: Record<string, unknown>) => { write = { op: "insert", values }; fixture.writes.push(write); return query; },
    update: (values: Record<string, unknown>) => { write = { op: "update", values }; fixture.writes.push(write); return query; },
    eq: (column: string, value: unknown) => { if (column === "version") write.version = value; return query; },
    select: () => query, single: async () => fixture.result, maybeSingle: async () => fixture.result,
  };
  return query;
} } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
import { refresh, revalidatePath } from "next/cache";
import { saveHomeLayout } from "./dashboard-actions";

beforeEach(() => { fixture.writes = []; fixture.result = { data: { version: 4 }, error: null }; vi.mocked(revalidatePath).mockClear(); vi.mocked(refresh).mockClear(); });

it("saves the grid's order and widths against the version it loaded, without re-rendering Home", async () => {
  await expect(saveHomeLayout(3, ["accounts", "overview"], { accounts: "L", overview: "S", unknown: "M" })).resolves.toEqual({ version: 4 });
  expect(fixture.writes).toEqual([{ op: "update", values: expect.objectContaining({ items: ["accounts", "overview"], sizes: { accounts: "L" }, version: 4 }), version: 3 }]);
  expect(revalidatePath).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it("refreshes Home only when a widget was added, so its content arrives", async () => {
  await saveHomeLayout(3, ["accounts", "goals"], {}, true);
  expect(refresh).toHaveBeenCalledOnce();
});

it("creates the first layout and reports another tab's save instead of overwriting it", async () => {
  fixture.result = { data: { version: 1 }, error: null };
  await expect(saveHomeLayout(0, ["goals"], {})).resolves.toEqual({ version: 1 });
  expect(fixture.writes[0]).toMatchObject({ op: "insert", values: { workspace_id: "workspace", items: ["goals"], sizes: {} } });
  fixture.result = { data: null, error: { code: "23505" } };
  await expect(saveHomeLayout(0, ["goals"], {})).resolves.toEqual({ error: "Home changed in another tab" });
  fixture.result = { data: null, error: null };
  await expect(saveHomeLayout(2, ["goals"], {})).resolves.toEqual({ error: "Home changed in another tab" });
});

it("rejects widgets that do not exist or appear twice", async () => {
  await expect(saveHomeLayout(1, ["goals", "goals"], {})).rejects.toThrow();
  await expect(saveHomeLayout(1, ["constructor"], {})).rejects.toThrow();
  expect(fixture.writes).toEqual([]);
});
