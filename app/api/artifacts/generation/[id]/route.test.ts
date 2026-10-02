import { expect, it, vi } from "vitest";
import { DELETE } from "./route";
const fixture = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ supabase: fixture, workspace: { id: "workspace" } }) }));
it("returns persisted effective cancellation without a service role credential", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  fixture.rpc.mockResolvedValue({ data: "canceled", error: null });
  const result = await DELETE(new Request("http://localhost"), { params: Promise.resolve({ id }) });
  expect(await result.json()).toEqual({ status: "canceled" });
  expect(fixture.rpc).toHaveBeenCalledWith("cancel_artifact_generation", { p_request_id: id });
});
it("rejects invalid request identities before querying a receipt", async () => {
  fixture.rpc.mockClear();
  const result = await DELETE(new Request("http://localhost"), { params: Promise.resolve({ id: "invalid" }) });
  expect(result.status).toBe(400); expect(fixture.rpc).not.toHaveBeenCalled();
});
