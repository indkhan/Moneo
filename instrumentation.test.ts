import { afterEach, expect, it, vi } from "vitest";
import { register } from "./instrumentation";
import { createServer, type AddressInfo } from "node:net";
import { getAllPorts } from "@workflow/utils/get-port";
const startWorld = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({ start: startWorld }) }));

const report = process.report as NodeJS.ProcessReport & { excludeNetwork: boolean };
const originalExcludeNetwork = report.excludeNetwork;
afterEach(() => { report.excludeNetwork = originalExcludeNetwork; vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each([
  ["nodejs", undefined, true],
  ["nodejs", "1", false],
  ["edge", undefined, false],
])("avoids reverse DNS during local Workflow port discovery", async (runtime, vercel, expected) => {
  report.excludeNetwork = false;
  vi.stubEnv("NEXT_RUNTIME", runtime);
  vi.stubEnv("VERCEL", vercel);
  await register();
  expect(report.excludeNetwork).toBe(expected);
});

it("awaits local persisted Workflow recovery at server startup", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("VERCEL", undefined);
  await register();
  expect(startWorld).toHaveBeenCalledTimes(1);
});
it("leaves deployed Vercel queue recovery to the runtime platform", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("VERCEL", "1");
  await register();
  expect(startWorld).not.toHaveBeenCalled();
});
it("surfaces local runtime initialization failure", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("VERCEL", undefined);
  startWorld.mockRejectedValueOnce(new Error("persisted world unavailable"));
  await expect(register()).rejects.toThrow("persisted world unavailable");
});

it("retains listening socket ports for the actual Workflow lookup", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("VERCEL", undefined);
  await register();
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    expect(await getAllPorts()).toContain((server.address() as AddressInfo).port);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
