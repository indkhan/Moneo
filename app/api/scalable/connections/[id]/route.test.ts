import { expect, it, vi } from "vitest";
import { DELETE } from "./route";

const rpc = vi.fn(async () => ({ error: null }));
const revoked = vi.fn(async () => ({ data: [{ id: "c" }], error: null }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w1" } }) }));
vi.mock("@/lib/service-db", () => ({ serviceDb: () => ({ rpc, from: () => ({ update: () => { const chain = { eq: () => chain, select: revoked }; return chain; } }) }) }));
const id = "6f1d2b0e-5a3c-4c53-9a43-2d3f4f6e8a10";
const call = () => DELETE(new Request("http://localhost"), { params: Promise.resolve({ id }) });

it("removes the stored charts of the workspace when Scalable is disconnected", async () => {
  expect((await call()).status).toBe(200);
  expect(rpc).toHaveBeenCalledWith("remove_scalable_charts", { p_workspace_id: "w1" });
});

it("keeps the charts when the connection was not this workspace's", async () => {
  rpc.mockClear();
  revoked.mockResolvedValueOnce({ data: [], error: null });
  expect((await call()).status).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
});
