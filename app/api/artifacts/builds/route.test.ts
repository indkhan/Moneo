import { beforeEach, expect, it, vi } from "vitest";

import { requireWorkspace } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
const auth = { requireWorkspace: vi.mocked(requireWorkspace) as unknown as ReturnType<typeof vi.fn> };

const build = { id: "b1", prompt: "Rent what-if", status: "running", error: null, artifact_id: null, created_at: new Date().toISOString() };
function client(rows: unknown[], seen: { artifact?: string } = {}) {
  const query = { select: () => query, eq: (key: string, value: string) => { if (key === "artifact_id") seen.artifact = value; return query; }, neq: () => query, gte: () => query, order: () => query,
    limit: async () => ({ data: rows, error: null }) };
  return { from: () => query };
}
beforeEach(() => { auth.requireWorkspace.mockReset(); });

it("needs a signed-in workspace", async () => {
  auth.requireWorkspace.mockImplementation(async () => { throw new Error("no session"); });
  expect((await GET(new Request("http://x/api/artifacts/builds"))).status).toBe(401);
});
it("lists the workspace's running builds, optionally for one artifact", async () => {
  const seen: { artifact?: string } = {};
  auth.requireWorkspace.mockResolvedValue({ supabase: client([build], seen), workspace: { id: "w" } });
  const artifact = "00000000-0000-4000-8000-000000000001";
  const response = await GET(new Request(`http://x/api/artifacts/builds?artifact=${artifact}`));
  expect((await response.json()).builds).toEqual([{ id: "b1", prompt: "Rent what-if", status: "running", error: null, artifact_id: null }]);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(seen.artifact).toBe(artifact);
});
it("ignores an artifact filter that is not an id", async () => {
  const seen: { artifact?: string } = {};
  auth.requireWorkspace.mockResolvedValue({ supabase: client([], seen), workspace: { id: "w" } });
  await GET(new Request("http://x/api/artifacts/builds?artifact=nope"));
  expect(seen.artifact).toBeUndefined();
});
