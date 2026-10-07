import { beforeEach, expect, it, vi } from "vitest";
import { DELETE } from "./route";
const fixture = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ supabase: fixture, workspace: { id: "workspace" } }) }));
beforeEach(() => vi.clearAllMocks());
it("returns effective persisted cancellation from the authenticated atomic RPC", async () => {
  fixture.rpc.mockResolvedValue({ data: "canceled", error: null });
  const response = await DELETE(new Request("http://localhost"), { params: Promise.resolve({ id: "job" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "canceled" });
  expect(fixture.rpc).toHaveBeenCalledWith("cancel_financial_review", { p_job_id: "job" });
  expect(fixture.from).not.toHaveBeenCalled();
});
it("keeps foreign or missing review cancellation unavailable", async () => {
  fixture.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "Review job not found" } });
  const response = await DELETE(new Request("http://localhost"), { params: Promise.resolve({ id: "foreign" }) });
  expect(response.status).toBe(404);
});

it("returns a cancellation request without claiming worker acknowledgment", async () => {
  fixture.rpc.mockResolvedValue({ data: "cancel_requested", error: null });
  const response = await DELETE(new Request("http://localhost"), { params: Promise.resolve({ id: "job" }) });
  expect(await response.json()).toEqual({ status: "cancel_requested" });
});
