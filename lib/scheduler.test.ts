import { afterEach, expect, it, vi } from "vitest";
import { CRON_JOBS, runCronJobs, startScheduler } from "./scheduler";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("calls every job in order with the cron secret and keeps going after a failure", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetcher = vi.fn(async (url: URL | RequestInfo) => {
    if (String(url).endsWith("/api/cron/reviews")) throw new Error("down");
    return new Response("{}", { status: String(url).endsWith("bank-sync") ? 503 : 200 });
  });
  await runCronJobs("http://127.0.0.1:3000", "secret", fetcher as typeof fetch);
  expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(CRON_JOBS.map(path => `http://127.0.0.1:3000${path}`));
  expect(fetcher.mock.calls.every(call => (call[1]?.headers as Record<string, string>).authorization === "Bearer secret")).toBe(true);
  // A feature that isn't set up (503) is not worth a warning; the thrown error is.
  expect(console.warn).toHaveBeenCalledOnce();
});

it("does not schedule anything without a cron secret", () => {
  expect(startScheduler({})).toBeNull();
});

it("runs a minute after start and then hourly against this server", async () => {
  vi.useFakeTimers();
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  const stop = startScheduler({ CRON_SECRET: "secret", PORT: "4000" })!;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(CRON_JOBS.length);
  expect(String(fetcher.mock.calls[0][0])).toBe("http://127.0.0.1:4000/api/cron/summaries");
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(fetcher).toHaveBeenCalledTimes(CRON_JOBS.length * 2);
  stop();
});
