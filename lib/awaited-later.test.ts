import { expect, it, vi } from "vitest";
import { awaitedLater } from "./awaited-later";

it("keeps a failure for the place that awaits it and raises no unhandled rejection meanwhile", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  const started = awaitedLater(Promise.reject(new Error("model unavailable")));
  await new Promise(resolve => setImmediate(resolve));
  process.off("unhandledRejection", unhandled);
  expect(unhandled).not.toHaveBeenCalled();
  await expect(started).rejects.toThrow("model unavailable");
});

it("passes a result through unchanged", async () => {
  await expect(awaitedLater(Promise.resolve(7))).resolves.toBe(7);
});
