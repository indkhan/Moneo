import { afterEach, expect, it, vi } from "vitest";
import { register } from "./instrumentation";
import { createServer, type AddressInfo } from "node:net";
import { getAllPorts } from "@workflow/utils/get-port";
const startWorld = vi.hoisted(() => vi.fn(async () => {}));
const startScheduler = vi.hoisted(() => vi.fn());
const startBankReturnListener = vi.hoisted(() => vi.fn());
vi.mock("workflow/runtime", () => ({ getWorld: () => ({ start: startWorld }) }));
vi.mock("@/lib/scheduler", () => ({ startScheduler }));
vi.mock("@/lib/bank/return-listener", () => ({ startBankReturnListener }));

const report = process.report as NodeJS.ProcessReport & { excludeNetwork: boolean };
const originalExcludeNetwork = report.excludeNetwork;
afterEach(() => { report.excludeNetwork = originalExcludeNetwork; vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each([["nodejs", true], ["edge", false]])("avoids reverse DNS during local Workflow port discovery (%s)", async (runtime, expected) => {
  report.excludeNetwork = false;
  vi.stubEnv("NEXT_RUNTIME", runtime);
  await register();
  expect(report.excludeNetwork).toBe(expected);
});

it("awaits persisted Workflow recovery, then starts the background jobs", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  await register();
  expect(startWorld).toHaveBeenCalledTimes(1);
  expect(startScheduler).toHaveBeenCalledTimes(1);
});

it("surfaces runtime initialization failure", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  startWorld.mockRejectedValueOnce(new Error("persisted world unavailable"));
  await expect(register()).rejects.toThrow("persisted world unavailable");
  expect(startScheduler).not.toHaveBeenCalled();
});

it.each([["1", "1", false], ["1", "0", true], ["0", "1", true]])("suppresses background work only for an explicit desktop preview (%s, %s)", async (desktop, preview, starts) => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("MONEO_DESKTOP", desktop);
  vi.stubEnv("MONEO_DESKTOP_PREVIEW", preview);
  await register();
  expect(startWorld).toHaveBeenCalledTimes(starts ? 1 : 0);
  expect(startScheduler).toHaveBeenCalledTimes(starts ? 1 : 0);
  expect(startBankReturnListener).toHaveBeenCalledTimes(starts ? 1 : 0);
});

it("retains listening socket ports for the actual Workflow lookup", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  await register();
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    expect(await getAllPorts()).toContain((server.address() as AddressInfo).port);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("keeps server connections open between page loads", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  const { getGlobalDispatcher } = await import("undici");
  const before = getGlobalDispatcher();
  await register();
  expect(getGlobalDispatcher()).not.toBe(before);
});
