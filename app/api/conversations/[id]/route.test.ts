import { beforeEach, expect, it, vi } from "vitest";
import { DELETE, PATCH } from "./route";
import { requireWorkspace } from "@/lib/auth";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

const id = "00000000-0000-4000-8000-000000000001";
const filters: unknown[][] = [];
let updated: unknown;
let row: unknown;
beforeEach(() => {
  filters.length = 0; updated = undefined; row = { id, title: "Renamed", created_at: "2026-01-01T00:00:00Z" };
  const query = {
    update: (values: unknown) => { updated = values; return query; },
    eq: (...args: unknown[]) => { filters.push(args); return query; },
    is: (...args: unknown[]) => { filters.push(args); return query; },
    select: () => query, maybeSingle: async () => ({ data: row, error: null }),
  };
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "owned" }, supabase: { from: () => query } } as never);
});
const route = (value = id) => ({ params: Promise.resolve({ id: value }) });
const patch = (body: unknown) => new Request("http://localhost", { method: "PATCH", body: JSON.stringify(body) });
const remove = () => new Request("http://localhost", { method: "DELETE" });

it("renames only a live conversation in the signed-in workspace with a validated title", async () => {
  const response = await PATCH(patch({ title: "  Renamed  " }), route());
  expect(response.status).toBe(200);
  expect(updated).toEqual({ title: "Renamed" });
  expect(filters).toEqual([["workspace_id", "owned"], ["id", id], ["deleted_at", null]]);
  for (const body of [{ title: "" }, { title: "x".repeat(121) }, { title: "ok", workspace_id: "other" }]) expect((await PATCH(patch(body), route())).status).toBe(400);
  expect((await PATCH(patch({ title: "ok" }), route("not-a-uuid"))).status).toBe(404);
});

it("soft-deletes so chat requests, audited edits and evidence stay intact", async () => {
  const response = await DELETE(remove(), route());
  expect(await response.json()).toEqual({ deleted: true });
  expect(updated).toEqual({ deleted_at: expect.any(String) });
  row = null;
  expect((await DELETE(remove(), route())).status).toBe(404);
});

it("requires authentication", async () => {
  vi.mocked(requireWorkspace).mockRejectedValue(new Error("Unauthorized"));
  expect((await DELETE(remove(), route())).status).toBe(401);
});
