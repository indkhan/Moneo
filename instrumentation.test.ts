import { afterEach, expect, it, vi } from "vitest";
import { register } from "./instrumentation";
import { createServer, type AddressInfo } from "node:net";
import { getAllPorts } from "@workflow/utils/get-port";

const report = process.report as NodeJS.ProcessReport & { excludeNetwork: boolean };
const originalExcludeNetwork = report.excludeNetwork;
afterEach(() => { report.excludeNetwork = originalExcludeNetwork; vi.unstubAllEnvs(); });

it.each([
  ["nodejs", undefined, true],
  ["nodejs", "1", false],
  ["edge", undefined, false],
])("avoids reverse DNS during local Workflow port discovery", (runtime, vercel, expected) => {
  report.excludeNetwork = false;
  vi.stubEnv("NEXT_RUNTIME", runtime);
  vi.stubEnv("VERCEL", vercel);
  register();
  expect(report.excludeNetwork).toBe(expected);
});

it("retains listening socket ports for the actual Workflow lookup", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("VERCEL", undefined);
  register();
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    expect(await getAllPorts()).toContain((server.address() as AddressInfo).port);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
