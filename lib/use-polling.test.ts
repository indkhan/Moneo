import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }), useEffect: (effect: () => void | (() => void)) => { host.effects.push(effect); } }));
let poll: typeof import("./use-polling").usePolling;

let hidden = false;
const listeners = new Set<() => void>();
beforeEach(async () => {
  vi.resetModules();
  ({ usePolling: poll } = await import("./use-polling"));
  vi.useFakeTimers(); hidden = false; listeners.clear(); host.effects = [];
  vi.stubGlobal("document", { get hidden() { return hidden; }, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const toggle = (next: boolean) => { hidden = next; listeners.forEach(fn => fn()); };
function mount(task: (signal: AbortSignal) => void | Promise<void>, active = true, options?: { immediate?: boolean }) {
  host.effects = []; poll(task, 3000, active, options);
  const effects = [...host.effects];
  const cleanups = effects.map(effect => effect()).filter(Boolean) as (() => void)[];
  return { unmount: () => cleanups.forEach(cleanup => cleanup()), remount: () => { cleanups.forEach(cleanup => cleanup()); effects.forEach(effect => effect()); } };
}

it("ticks every interval while active and stops on unmount", () => {
  const task = vi.fn(); const view = mount(task);
  vi.advanceTimersByTime(9000); expect(task).toHaveBeenCalledTimes(3);
  view.unmount(); vi.advanceTimersByTime(9000); expect(task).toHaveBeenCalledTimes(3);
});
it("does nothing when not active", () => {
  const task = vi.fn(); mount(task, false); vi.advanceTimersByTime(9000);
  expect(task).not.toHaveBeenCalled(); expect(listeners.size).toBe(0);
});
it("pauses in a hidden tab and checks once when it comes back", () => {
  const task = vi.fn(); mount(task);
  toggle(true); vi.advanceTimersByTime(30_000); expect(task).not.toHaveBeenCalled();
  toggle(false); expect(task).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3000); expect(task).toHaveBeenCalledTimes(2);
});
it("does not poll at all when mounted in a hidden tab", () => {
  hidden = true; const task = vi.fn(); mount(task); vi.advanceTimersByTime(9000); expect(task).not.toHaveBeenCalled();
});
it("never starts a second request while the first is still running", async () => {
  let finish!: () => void;
  const task = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  mount(task);
  vi.advanceTimersByTime(12_000); expect(task).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(3000); expect(task).toHaveBeenCalledTimes(2);
});
it("keeps polling after a failed request", async () => {
  const task = vi.fn(() => Promise.reject(new Error("offline")));
  mount(task);
  await vi.advanceTimersByTimeAsync(9000); expect(task).toHaveBeenCalledTimes(3);
});
it("aborts the request in flight on unmount and when the tab hides", () => {
  const signals: AbortSignal[] = [];
  const view = mount(signal => { signals.push(signal); return new Promise<void>(() => undefined); });
  vi.advanceTimersByTime(3000); toggle(true); expect(signals[0].aborted).toBe(true);
  toggle(false); expect(signals[1].aborted).toBe(false);
  view.unmount(); expect(signals[1].aborted).toBe(true);
});
it("runs once on activation when asked to", () => {
  const task = vi.fn(); mount(task, true, { immediate: true }); expect(task).toHaveBeenCalledTimes(1);
});
it("keeps one timer when React mounts, unmounts and mounts again in development", () => {
  const task = vi.fn(); const view = mount(task);
  view.remount(); vi.advanceTimersByTime(9000); expect(task).toHaveBeenCalledTimes(3); expect(listeners.size).toBe(1);
});
