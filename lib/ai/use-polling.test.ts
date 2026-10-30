import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }), useEffect: (effect: () => void | (() => void)) => { host.effects.push(effect); } }));
import { usePolling as poll } from "./use-polling";

let hidden = false;
const listeners = new Set<() => void>();
beforeEach(() => {
  vi.useFakeTimers(); hidden = false; listeners.clear(); host.effects = [];
  vi.stubGlobal("document", { get hidden() { return hidden; }, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const toggle = (next: boolean) => { hidden = next; listeners.forEach(fn => fn()); };
/** Runs the hook's effects like React would on mount; returns the cleanup of the polling one. */
function mount(tick: () => void, active = true) {
  host.effects = []; poll(tick, 3000, active);
  return host.effects.map(effect => effect()).filter(Boolean).at(-1) as (() => void) | undefined;
}

it("ticks every interval while active and stops on cleanup", () => {
  const tick = vi.fn(); const cleanup = mount(tick);
  vi.advanceTimersByTime(9000); expect(tick).toHaveBeenCalledTimes(3);
  cleanup!(); vi.advanceTimersByTime(9000); expect(tick).toHaveBeenCalledTimes(3);
});
it("does nothing when not active", () => {
  const tick = vi.fn(); mount(tick, false); vi.advanceTimersByTime(9000);
  expect(tick).not.toHaveBeenCalled(); expect(listeners.size).toBe(0);
});
it("pauses in a hidden tab and checks once when it comes back", () => {
  const tick = vi.fn(); mount(tick);
  toggle(true); vi.advanceTimersByTime(30_000); expect(tick).not.toHaveBeenCalled();
  toggle(false); expect(tick).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3000); expect(tick).toHaveBeenCalledTimes(2);
});
it("does not poll at all when mounted in a hidden tab", () => {
  hidden = true; const tick = vi.fn(); mount(tick); vi.advanceTimersByTime(9000); expect(tick).not.toHaveBeenCalled();
});
