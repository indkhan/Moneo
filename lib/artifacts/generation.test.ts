import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runArtifactGeneration } from "./generation";

const input = { requestId: "request", purpose: "calculator" as const, description: "Exact calculator", artifactId: "artifact" };
it("replays a completed receipt without another provider call", async () => {
  const rpc = vi.fn(async () => ({ data: { started: false, status: "completed", result: { source: "Exact original" } }, error: null }));
  const generate = vi.fn();
  const response = await runArtifactGeneration({ rpc } as unknown as SupabaseClient, new Request("http://localhost"), input, generate);
  expect(response.status).toBe(200); expect((await response.json()).source).toBe("Exact original"); expect(generate).not.toHaveBeenCalled();
});
it("does not expose or persist a late draft when cancellation wins", async () => {
  const rpc = vi.fn().mockResolvedValueOnce({ data: { started: true, status: "running" }, error: null }).mockResolvedValueOnce({ data: "canceled", error: null });
  const response = await runArtifactGeneration({ rpc } as unknown as SupabaseClient, new Request("http://localhost"), input, async () => ({ result: { source: "Late draft" }, usage: null }));
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ status: "canceled" });
});
it("persists a provider failure with unknown usage rather than a fallback success", async () => {
  const rpc = vi.fn().mockResolvedValueOnce({ data: { started: true, status: "running" }, error: null }).mockResolvedValueOnce({ data: "failed", error: null });
  const response = await runArtifactGeneration({ rpc } as unknown as SupabaseClient, new Request("http://localhost"), input, async () => { throw new Error("Provider unavailable"); });
  expect(response.status).toBe(502);
  expect(rpc).toHaveBeenLastCalledWith("finish_artifact_generation", expect.objectContaining({ p_status: "failed", p_result: null, p_usage: null, p_error: "Provider unavailable" }));
});
it("cancels an already-aborted claimed request before sending any provider work", async () => {
  const controller = new AbortController(); controller.abort();
  const rpc = vi.fn().mockResolvedValueOnce({ data: { started: true, status: "running" }, error: null }).mockResolvedValueOnce({ data: "canceled", error: null });
  const generate = vi.fn();
  const response = await runArtifactGeneration({ rpc } as unknown as SupabaseClient, new Request("http://localhost", { signal: controller.signal }), input, generate);
  expect(response.status).toBe(409); expect(generate).not.toHaveBeenCalled();
});
