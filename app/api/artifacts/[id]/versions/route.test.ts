import { beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const fixture = vi.hoisted(() => ({ rpc: vi.fn(), before: vi.fn(), limit: vi.fn(), validation: vi.fn() }));
const id = "00000000-0000-4000-8000-000000000001";
const base = "00000000-0000-4000-8000-000000000002";
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "workspace" }, supabase: {
  rpc: fixture.rpc,
  from: (table: string) => {
    const query = { select: () => query, eq: () => query, order: () => query,
      lt: (column: string, value: number) => { fixture.before(column, value); return query; },
      limit: async (count: number) => { fixture.limit(count); return { data: Array.from({ length: 21 }, (_, i) => ({ id: String(i), version: 50 - i, source: "input => ({})" })), error: null }; },
      maybeSingle: async () => ({ data: table === "artifacts" ? { id, kind: "custom_comparison", permissions: [], active_version_id: base } : { state: {} }, error: null }),
    }; return query;
  },
} }) }));
vi.mock("@/lib/artifacts/validate", () => ({ validateGeneratedCandidate: fixture.validation }));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.validation.mockResolvedValue({ ok: true, manifest: {}, warnings: [] });
  fixture.rpc.mockResolvedValue({ data: { id: "new", version: 3 }, error: null });
});
const params = { params: Promise.resolve({ id }) };
const save = (body: unknown) => POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(body) }), params);
it("requires the version the user actually edited", async () => {
  expect((await save({ source: "input => ({})", manifest: {} })).status).toBe(400);
  expect(fixture.rpc).not.toHaveBeenCalled();
});
it("passes the expected active version into the locked activation RPC", async () => {
  expect((await save({ source: "input => ({})", manifest: {}, expectedActiveVersionId: base })).status).toBe(200);
  expect(fixture.rpc).toHaveBeenCalledWith("save_generated_artifact_version", expect.objectContaining({ p_expected_active_version_id: base }));
});
it("returns a recoverable conflict from the transaction, including the current revision", async () => {
  fixture.rpc.mockResolvedValue({ data: null, error: { code: "40001", message: "Active version changed" } });
  const response = await save({ source: "input => ({})", manifest: {}, expectedActiveVersionId: base });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ activeVersionId: base });
});
it("pages history by immutable version number with one lookahead row", async () => {
  const response = await GET(new Request("http://localhost?before=51"), params);
  const data = await response.json();
  expect(fixture.before).toHaveBeenCalledWith("version", 51);
  expect(fixture.limit).toHaveBeenCalledWith(21);
  expect(data.versions).toHaveLength(20);
  expect(data.nextCursor).toBe(31);
  expect(data.versions[0].source).toBeTruthy();
});
it("rejects malformed history cursors", async () => {
  expect((await GET(new Request("http://localhost?before=garbage"), params)).status).toBe(400);
});
it("restores trusted history by identity without accepting client source or validation status", async () => {
  const response = await save({ restoreTrustedVersionId: id, expectedActiveVersionId: base });
  expect(response.status).toBe(200);
  expect(fixture.rpc).toHaveBeenCalledWith("restore_trusted_artifact_version", {
    p_artifact_id: id, p_version_id: id, p_expected_active_version_id: base,
  });
  expect(fixture.validation).not.toHaveBeenCalled();
  expect((await save({ restoreTrustedVersionId: id, expectedActiveVersionId: base, source: "arbitrary", status: "validated" })).status).toBe(400);
});
