import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, vi } from "vitest";

Object.assign(globalThis, { AsyncLocalStorage });

let env: NodeJS.ProcessEnv;
beforeAll(() => { env = { ...process.env }; });

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
  Object.assign(process.env, env);
});
