import { describe, expect, it, vi } from "vitest";
import { startOutboxDispatcher } from "./dispatcher.js";

describe("production outbox dispatcher loop", () => {
  it("dispatches immediately, continues on a timer, and stops cleanly", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn().mockResolvedValue({ claimed: 0, published: 0, failed: 0 });
    const errors: unknown[] = [];
    const stop = startOutboxDispatcher(dispatch, (error) => errors.push(error), 1000);

    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatch).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
    vi.useRealTimers();
  });

  it("reports an error and keeps dispatching", async () => {
    vi.useFakeTimers();
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("postgres unavailable"))
      .mockResolvedValue({ claimed: 0, published: 0, failed: 0 });
    const errors: unknown[] = [];
    const stop = startOutboxDispatcher(dispatch, (error) => errors.push(error), 1000);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    stop();
    vi.useRealTimers();
  });
});
