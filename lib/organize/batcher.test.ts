import { afterEach, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { runAdaptive, tokenBatches } from "./batcher";

const throttled = (body: string) => new APICallError({ message: "Too Many Requests", url: "https://synthetic.invalid", requestBodyValues: {}, statusCode: 429, responseBody: body });
afterEach(() => vi.useRealTimers());
// Model calls that take a while, on fake timers.
const later = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it("fills batches up to a token budget and an item cap", () => {
  expect(tokenBatches([5, 5, 5, 20, 1, 1, 1], size => size, 12, 2)).toEqual([[5, 5], [5], [20], [1, 1], [1]]);
});

// The old categorizer asked batch after batch, one at a time: 2.5 minutes of a 2.5-minute run.
it("grows parallelism on success, halves it on a throttle and retries after a pause", async () => {
  vi.useFakeTimers();
  let active = 0;
  const seen: number[] = [], throttledOnce = new Set<number>();
  const work = async (job: number) => {
    active++; seen.push(active);
    await later(100);
    active--;
    if (job === 3 && !throttledOnce.has(job)) { throttledOnce.add(job); throw throttled('{"error":{"type":"rate_limit_exceeded"}}'); }
    return job * 10;
  };
  const running = runAdaptive([1, 2, 3, 4, 5, 6, 7, 8], work, { start: 2, max: 4, backoffMs: 1000 });
  await vi.runAllTimersAsync();
  const result = await running;
  expect(seen.slice(0, 2)).toEqual([1, 2]);
  expect(Math.max(...seen)).toBeLessThanOrEqual(4);
  expect(result.peak).toBeGreaterThan(2);
  expect(result.done.map(item => item.result).sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  expect(result).toMatchObject({ left: [], failed: [], stopped: null });
});

it("stops at the plan's usage limit and leaves the rest for the next run without failing", async () => {
  vi.useFakeTimers();
  const started: number[] = [];
  const running = runAdaptive([1, 2, 3, 4, 5], async job => {
    started.push(job);
    await later(10);
    if (job === 2) throw throttled('{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}');
    return job;
  }, { start: 2 });
  await vi.runAllTimersAsync();
  const result = await running;
  // Calls already under way finish; nothing new starts after the limit.
  expect(started).not.toContain(5);
  expect(result.left.sort()).toEqual([2, 5]);
  expect([...result.done.map(item => item.job), ...result.left].sort()).toEqual([1, 2, 3, 4, 5]);
  expect(result.failed).toEqual([]);
  expect(APICallError.isInstance(result.stopped)).toBe(true);
});
