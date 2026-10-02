import { expect, it, vi } from "vitest";
import { POST } from "@/app/api/imports/[id]/classification/route";
import { requireWorkspace } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
const transactionId = "11111111-1111-4111-a111-111111111111";
const request = (body: unknown) => new Request("http://localhost/api/imports/import/classification", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const params = { params: Promise.resolve({ id: "import" }) };

it("refuses a target outside the selected import and workspace before the mutation RPC", async () => {
  const filters: unknown[][] = [];
  const rpc = vi.fn();
  const query = { select: () => query, eq: (...args: unknown[]) => { filters.push(args); return query; }, limit: async () => ({ data: [], error: null }) };
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "workspace" }, supabase: { from: () => query, rpc } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  const response = await POST(request({ action: "review", transactionId, version: 0, kind: "ordinary" }), params);
  expect(response.status).toBe(404);
  expect(filters).toContainEqual(["source_transactions.workspace_id", "workspace"]);
  expect(filters).toContainEqual(["source_transactions.import_id", "import"]);
  expect(rpc).not.toHaveBeenCalled();
});

it("requires an explicit valid optimistic version and authentication", async () => {
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "workspace" } } as Awaited<ReturnType<typeof requireWorkspace>>);
  expect((await POST(request({ action: "review", transactionId, version: null, kind: "ordinary" }), params)).status).toBe(400);
  vi.mocked(requireWorkspace).mockRejectedValueOnce(new Error("unauthorized"));
  expect((await POST(request({ action: "review", transactionId, version: 0, kind: "ordinary" }), params)).status).toBe(401);
});
