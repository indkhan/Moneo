import { expect, it, vi } from "vitest";
import { POST } from "./route";
import { requireWorkspace } from "@/lib/auth";
import { start } from "workflow/api";
import { createClient } from "@supabase/supabase-js";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({})) }));
vi.mock("@/workflows/import-file", () => ({ importFile: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
it("returns effective cancellation and starts only a newly resumed version", async () => {
  const rpc = vi.fn().mockResolvedValueOnce({ data: { status: "canceled", started: true, runVersion: 2 }, error: null })
    .mockResolvedValueOnce({ data: { status: "queued", started: true, runVersion: 3, totalRows: 27 }, error: null })
    .mockResolvedValueOnce({ data: { status: "running", started: false, runVersion: 3 }, error: null });
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { rpc }, workspace: { id: "workspace" } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test");
  const id = "00000000-0000-4000-8000-000000000001", requestId = "00000000-0000-4000-8000-000000000002";
  const call = (action: string) => POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ action, requestId }) }), { params: Promise.resolve({ id }) });
  expect(await (await call("cancel")).json()).toMatchObject({ status: "canceled" });
  expect(start).not.toHaveBeenCalled();
  await call("resume"); await call("resume");
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith(expect.anything(), [id, "workspace", 27, 3]);
  vi.unstubAllEnvs();
});

it("persists a launch failure against its version and preserves a concurrent cancellation on replay", async () => {
  vi.mocked(start).mockClear().mockRejectedValueOnce(new Error("Launch unavailable"));
  const rpc = vi.fn().mockResolvedValueOnce({ data: { status: "queued", started: true, runVersion: 3, totalRows: 27 }, error: null })
    .mockResolvedValueOnce({ data: { status: "canceled", started: false, runVersion: 4 }, error: null });
  const finish = vi.fn().mockResolvedValue({ data: "canceled", error: null });
  vi.mocked(createClient).mockReturnValue({ rpc: finish } as unknown as ReturnType<typeof createClient>);
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { rpc }, workspace: { id: "workspace" } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test");
  const id = "00000000-0000-4000-8000-000000000001";
  const call = () => POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ action: "resume", requestId: "00000000-0000-4000-8000-000000000002" }) }), { params: Promise.resolve({ id }) });
  const failed = await call();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ status: "canceled" });
  expect(finish).toHaveBeenCalledWith("finish_import_run", expect.objectContaining({ p_import_id: id, p_run_version: 3 }));
  expect(await (await call()).json()).toMatchObject({ status: "canceled", started: false, runVersion: 4 });
  expect(start).toHaveBeenCalledTimes(1);
  vi.unstubAllEnvs();
});
