import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { DatedTripForm } from "./dated-trip-form";
import { defaultTripScenario, evaluateTripScenario } from "@/lib/finance/trip-scenario";

// Exercise the real form and useStateDraft across effect cleanup and subsequent renders.
const host = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], effects: [] as (() => void)[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = host.index++;
    if (!(index in host.slots)) host.slots[index] = initial;
    return [host.slots[index], (next: unknown) => { host.slots[index] = typeof next === "function" ? next(host.slots[index]) : next; }];
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const index = host.index++, previous = host.slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      previous?.cleanup?.();
      host.effects.push(() => { host.slots[index] = { deps, cleanup: effect() }; });
    }
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ saveDatedTripState: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); host.slots = []; host.effects = []; host.index = 0; });

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => isValidElement(child)
    ? [child as ReactElement<Record<string, unknown>>, ...elements((child.props as { children?: ReactNode }).children)] : []);
}
it.each(["failed", "pending"])("Undo discards %s preview state and restores saved future evidence", async state => {
  vi.useFakeTimers();
  const initial = defaultTripScenario("2026-10-01", "EUR", "checking", 20000n);
  const initialResult = evaluateTripScenario({ startDate: "2026-10-01", horizonDays: 29, currencyCode: "EUR",
    accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 100000n }], events: [] }, initial);
  const reason = "Trip dates must not precede the current balance date";
  let resolve!: (value: unknown) => void;
  const fetch = vi.fn().mockReturnValue(new Promise(value => { resolve = value; }));
  vi.stubGlobal("fetch", fetch);
  let tree: ReactElement;
  function render() {
    host.index = 0;
    tree = DatedTripForm({ artifactId: "synthetic", stateVersion: 2, initial, initialResult, accounts: [{ id: "checking", currencyCode: "EUR" }] });
    const html = renderToStaticMarkup(tree);
    host.effects.splice(0).forEach(effect => effect());
    return html;
  }
  expect(render()).toContain("EUR 800.00");
  const input = elements(tree!).find(element => element.type === "input" && element.props.type === "date")!;
  (input.props.onChange as (event: unknown) => void)({ target: { value: "2026-09-01" } });
  render();
  await vi.advanceTimersByTimeAsync(300);
  expect(fetch).toHaveBeenCalledTimes(1);
  if (state === "failed") {
    resolve({ ok: false, json: async () => ({ error: reason }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(render()).toContain(reason);
  } else expect(render()).toContain("Recalculating dated scenario");
  const undo = elements(tree!).find(element => element.type === "button" && element.props.children === "Undo local changes")!;
  (undo.props.onClick as () => void)();
  render(); // Commit the scenario change and its effect.
  let html = render();
  expect(html).toContain('value="2026-10-08"');
  expect(html).toContain("EUR 800.00");
  expect(html).not.toContain(reason);
  expect(html).not.toContain("Recalculating dated scenario");
  expect((fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  if (state === "pending") {
    // A late rejected response from discarded inputs must not resurrect the alert.
    resolve({ ok: false, json: async () => ({ error: reason }) });
    await vi.advanceTimersByTimeAsync(0);
    html = render();
    expect(html).not.toContain(reason);
    expect(html).toContain("EUR 800.00");
  }
  await vi.advanceTimersByTimeAsync(300);
  expect(fetch).toHaveBeenCalledTimes(1);
  const nextInput = elements(tree!).find(element => element.type === "input" && element.props.type === "date")!;
  (nextInput.props.onChange as (event: unknown) => void)({ target: { value: "2026-10-09" } });
  render();
  expect(render()).toContain("Local changes awaiting dated preview.");
  expect(render()).not.toContain("Recalculating dated scenario");
});

it("expired complex draft can preview repaired future dates and Undo restores the honest limitation", async () => {
  vi.useFakeTimers();
  const initial = defaultTripScenario("2026-09-01", "EUR", "checking", 20000n);
  initial.payments.push({ ...initial.payments[0], kind: "contribution", amountMinor: "1000" });
  const repaired = { ...initial, startsOn: "2026-10-08", endsOn: "2026-10-08", payments: initial.payments.map(item => ({ ...item, date: "2026-10-08" })) };
  const result = evaluateTripScenario({ startDate: "2026-10-07", horizonDays: 23, currencyCode: "EUR", accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 100000n }], events: [] }, repaired);
  const reason = "Trip or payment date is in the past; choose future hypothetical dates";
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tripResult: result }) }); vi.stubGlobal("fetch", fetch);
  let tree: ReactElement;
  function render() {
    host.index = 0;
    tree = DatedTripForm({ artifactId: "synthetic", stateVersion: 2, initial, initialResult: null, currency: "EUR", initialError: reason, accounts: [{ id: "checking", currencyCode: "EUR" }] });
    const html = renderToStaticMarkup(tree); host.effects.splice(0).forEach(effect => effect()); return html;
  }
  expect(render()).toContain(reason); expect(render()).not.toContain('aria-label="Dated trip results"');
  for (let i = 0; i < 4; i++) {
    const dates = elements(tree!).filter(element => element.type === "input" && element.props.type === "date");
    (dates[i].props.onChange as (event: unknown) => void)({ target: { value: "2026-10-08" } }); render();
  }
  await vi.advanceTimersByTimeAsync(300);
  const html = render(); expect(html).toContain("EUR 810.00"); expect(html).not.toContain(reason);
  expect(JSON.parse(fetch.mock.calls[0][1].body).scenario).toEqual(repaired);
  const undo = elements(tree!).find(element => element.type === "button" && element.props.children === "Undo local changes")!;
  (undo.props.onClick as () => void)(); render();
  expect(render()).toContain(reason); expect(render()).not.toContain('aria-label="Dated trip results"');
});
