import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalculatorPanel } from "./calculator-panel";
import { calculatorManifestSchema } from "@/lib/artifacts/spec";

// Replay the component's effects and successive renders without a DOM dependency.
const host = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], params: { accountId: "" }, effects: [] as (() => void)[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = host.index++;
    if (!(index in host.slots)) host.slots[index] = initial;
    return [host.slots[index], (next: unknown) => { host.slots[index] = typeof next === "function" ? next(host.slots[index]) : next; }];
  },
  useRef: (current: unknown) => {
    const index = host.index++;
    if (!(index in host.slots)) host.slots[index] = { current };
    return host.slots[index];
  },
  useMemo: (create: () => unknown, deps: unknown[]) => {
    const index = host.index++, previous = host.slots[index] as { deps: unknown[]; value: unknown } | undefined;
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) host.slots[index] = { deps, value: create() };
    return (host.slots[index] as { value: unknown }).value;
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const index = host.index++, previous = host.slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      previous?.cleanup?.();
      host.effects.push(() => { host.slots[index] = { deps, cleanup: effect() }; });
    }
  },
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./actions", () => ({ saveCalculatorParams: vi.fn() }));
vi.mock("./use-state-draft", () => ({ useStateDraft: () => ({ value: host.params }), StateDraftRecovery: () => null }));
const bridge = vi.hoisted(() => ({ refresh: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/artifacts/trip-preview", () => ({ refreshTripSnapshot: bridge.refresh }));
vi.mock("@/lib/artifacts/run", () => ({ runIsolatedArtifact: bridge.run }));
afterEach(() => { vi.useRealTimers(); host.slots = []; host.effects = []; host.index = 0; vi.clearAllMocks(); });

it("clears the original unavailable alert only after the current owned account preview completes", async () => {
  vi.useFakeTimers();
  const reason = "Choose a paying account; aggregate cash requires explicit funding";
  const snapshot = { currency: "EUR", unavailable: reason };
  const manifest = calculatorManifestSchema.parse({ kind: "trip_planner", runtime: "quickjs-calculator-v1", sdk: ["forecast"], params: { accountId: { type: "string", default: "" } } });
  const initialParams = { accountId: "" };
  host.params = initialParams;
  bridge.run.mockResolvedValue({ summary: "Available owned account preview" });
  let resolve!: (value: unknown) => void;
  bridge.refresh.mockReturnValue(new Promise(value => { resolve = value; }));
  function render() {
    host.index = 0;
    const html = renderToStaticMarkup(<CalculatorPanel source="input => ({})" snapshot={snapshot} initialParams={initialParams} manifest={manifest} versionLabel="v1" artifactId="synthetic" />);
    host.effects.splice(0).forEach(effect => effect());
    return html;
  }
  expect(render()).toContain(reason);
  await vi.advanceTimersByTimeAsync(300);
  await vi.waitFor(() => expect(bridge.run).toHaveBeenCalledTimes(1));
  expect(render()).toContain(reason);
  host.params = { accountId: "owned" };
  let html = render();
  expect(html).toContain(reason);
  expect(html).not.toContain("Available owned account preview");
  expect(html).toMatch(/disabled=""[^>]*>Print \/ PDF/);
  await vi.advanceTimersByTimeAsync(300);
  expect(render()).toContain(reason);
  resolve({ currency: "EUR", unavailable: null, accountId: "owned" });
  await vi.waitFor(() => expect(bridge.run).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(0);
  html = render();
  expect(html).toContain("Available owned account preview");
  expect(html).not.toContain(reason);
  expect(html).not.toMatch(/disabled=""[^>]*>Print \/ PDF/);
  // A newer input invalidates completed output/export and restores saved evidence while pending.
  host.params = { accountId: "another-owned" };
  html = render();
  expect(html).toContain(reason);
  expect(html).not.toContain("Available owned account preview");
  expect(html).toMatch(/disabled=""[^>]*>Print \/ PDF/);
});

it("foreign scalar currency blocks worker/preview execution and export with an honest explanation", async () => {
  vi.useFakeTimers();
  const manifest = calculatorManifestSchema.parse({ kind: "trip_planner", runtime: "quickjs-calculator-v1", sdk: ["forecast"], params: { costMinor: { type: "number", default: 20000, currency: "USD" } } });
  const initialParams = { costMinor: 20000, accountId: "a" }; host.params = initialParams;
  function render() {
    host.index = 0;
    const html = renderToStaticMarkup(<CalculatorPanel source="input => ({summary:'Affordable'})" snapshot={{ currency: "EUR" }} currency="EUR" initialParams={initialParams} manifest={manifest} artifactId="synthetic" versionLabel="v1" />);
    host.effects.splice(0).forEach(effect => effect()); return html;
  }
  expect(render()).toMatch(/disabled=""[^>]*>Save inputs/);
  await vi.advanceTimersByTimeAsync(300);
  const html = render(); expect(html).toContain("Trip cost currency USD differs from forecast currency EUR");
  expect(html).toContain("explicit manual FX rate");
  expect(html).toMatch(/disabled=""[^>]*>Print \/ PDF/);
  expect(bridge.run).not.toHaveBeenCalled(); expect(bridge.refresh).not.toHaveBeenCalled();
});
