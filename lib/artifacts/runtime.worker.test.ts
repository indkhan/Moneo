import { afterEach, expect, it, vi } from "vitest";
import { calculatorManifestSchema } from "./spec";
const manifest = calculatorManifestSchema.parse({ kind: "custom_report", runtime: "quickjs-calculator-v1", sdk: [], params: {
  amount: { type: "number", default: 50, min: 0, max: 100 },
  reference: { type: "string", default: "00123" },
  costMinor: { type: "string", default: "9007199254740993" },
} });
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it("worker refuses out-of-contract input before sandbox execution", async () => {
  const host = { onmessage: null as null | ((event: { data: unknown }) => Promise<void>), postMessage: vi.fn() };
  vi.stubGlobal("self", host);
  await import("./runtime.worker");
  await host.onmessage!({ data: { source: 'input => ({numbers:{amount:input.params.amount}})', manifest, input: { params: { amount: 500 } } } });
  expect(host.postMessage).toHaveBeenCalledWith({ error: expect.stringContaining("Param amount") });
});
it("worker preserves numeric-looking strings and exact minor units", async () => {
  const host = { onmessage: null as null | ((event: { data: unknown }) => Promise<void>), postMessage: vi.fn() };
  vi.stubGlobal("self", host);
  await import("./runtime.worker");
  await host.onmessage!({ data: { source: 'input => ({numbers:{reference:input.params.reference,cost:String(BigInt(input.params.costMinor))}})', manifest, input: { params: { reference: "00007", costMinor: "9007199254740995" } } } });
  expect(host.postMessage).toHaveBeenCalledWith({ output: { numbers: { reference: "00007", cost: "9007199254740995" } } });
});
