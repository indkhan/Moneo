import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], refs: new Map<number, { current: unknown }>(), slot: 0 }));
vi.mock("react", () => ({
  useRef: (current: unknown) => { const key = host.slot++; if (!host.refs.has(key)) host.refs.set(key, { current }); return host.refs.get(key)!; },
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void | (() => void)) => { host.effects.push(effect); },
}));
import { useDelay, useTimeout } from "./use-timeout";

beforeEach(() => { vi.useFakeTimers(); host.effects = []; host.refs.clear(); host.slot = 0; });
afterEach(() => vi.useRealTimers());
function render<T>(hook: () => T) {
  host.effects = []; host.slot = 0;
  const value = hook();
  const effects = [...host.effects];
  const cleanups = effects.map(effect => effect()).filter(Boolean) as (() => void)[];
  return { value, unmount: () => cleanups.forEach(cleanup => cleanup()), remount: () => { cleanups.forEach(cleanup => cleanup()); effects.forEach(effect => effect()); } };
}

it("fires once after the delay and never after unmount", () => {
  const fire = vi.fn();
  render(() => useTimeout(fire, 6000, "a"));
  vi.advanceTimersByTime(5999); expect(fire).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(fire).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_000); expect(fire).toHaveBeenCalledTimes(1);
  const other = vi.fn(); const second = render(() => useTimeout(other, 6000, "b"));
  second.unmount(); vi.advanceTimersByTime(60_000); expect(other).not.toHaveBeenCalled();
});
it("stays off while the delay is null", () => {
  const fire = vi.fn(); render(() => useTimeout(fire, null)); vi.advanceTimersByTime(60_000); expect(fire).not.toHaveBeenCalled();
});
it("fires once when React mounts, unmounts and mounts again in development", () => {
  const fire = vi.fn(); const view = render(() => useTimeout(fire, 1000));
  view.remount(); vi.advanceTimersByTime(5000); expect(fire).toHaveBeenCalledTimes(1);
});
it("keeps only the latest scheduled delay and cancels it on unmount", () => {
  const first = vi.fn(), second = vi.fn();
  const view = render(useDelay);
  const [after, cancel] = view.value;
  after(first, 400); vi.advanceTimersByTime(300); after(second, 400); vi.advanceTimersByTime(400);
  expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
  after(first, 400); cancel(); vi.advanceTimersByTime(400); expect(first).not.toHaveBeenCalled();
  after(first, 400); view.unmount(); vi.advanceTimersByTime(400); expect(first).not.toHaveBeenCalled();
});
