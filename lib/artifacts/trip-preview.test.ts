import { afterEach, expect, it, vi } from "vitest";
import { refreshTripSnapshot } from "./trip-preview";
import { defaultTripScenario } from "@/lib/finance/trip-scenario";
afterEach(() => vi.unstubAllGlobals());
it("refreshes the scoped host scenario from edited local params and keeps the exact assumptions", async () => {
  const scenario = defaultTripScenario("2026-10-01", "EUR", "a", 20000n);
  const snapshot = { currency: "EUR", tripResult: { scenario } };
  const next = { ...snapshot, withTripAvailableMinor: "10000", evaluatedCostMinor: "30000" };
  const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json(next)); vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  expect(await refreshTripSnapshot(snapshot, { costMinor: 30000 }, "synthetic", signal)).toEqual(next);
  const init = fetcher.mock.calls[0][1] as RequestInit;
  expect(init.signal).toBe(signal);
  expect(JSON.parse(String(init.body))).toEqual({ artifactId: "synthetic", params: { costMinor: 30000 }, baseScenario: scenario });
});
it("does not run a stale or fabricated scenario when host evaluation fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Unknown account" }, { status: 400 })));
  await expect(refreshTripSnapshot({}, { accountId: "other" }, "synthetic", new AbortController().signal)).rejects.toThrow("Unknown account");
});
