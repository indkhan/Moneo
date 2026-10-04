import { afterEach, expect, it, vi } from "vitest";

vi.mock("workflow/next", () => ({ withWorkflow: (config: unknown) => config }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each([
  ["development", undefined, undefined, "http://localhost:3000"],
  ["development", undefined, "http://localhost:3100", "http://localhost:3100"],
  ["production", undefined, undefined, undefined],
  ["development", "1", undefined, undefined],
])("configures a known local Workflow URL without overriding deployment settings", async (mode, vercel, override, expected) => {
  vi.stubEnv("NODE_ENV", mode);
  vi.stubEnv("VERCEL", vercel);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", override);
  await import("./next.config");
  expect(process.env.WORKFLOW_LOCAL_BASE_URL).toBe(expected);
});
