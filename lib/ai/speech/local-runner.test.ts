import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkerRunner } from "./local-runner";

class FakeWorker extends EventEmitter {
  jobs: { id: number }[] = [];
  terminate = vi.fn(async () => 0);
  postMessage(message: { id: number }) { this.jobs.push(message); }
  answer(text: string) { const job = this.jobs.shift()!; this.emit("message", { id: job.id, text }); }
}
const job = () => ({ folder: "/models/whisper", family: "whisper" as const, dtype: "q8" as const, samples: new Float32Array(4), prompt: "" });
let workers: FakeWorker[];
const runner = () => createWorkerRunner(() => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; }, 1000);

beforeEach(() => { workers = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("keeps the model loaded between recordings and unloads it once it has been idle", async () => {
  const model = runner();
  const first = model.transcribe(job());
  workers[0].answer("one");
  expect(await first).toBe("one");
  vi.advanceTimersByTime(900);
  const second = model.transcribe(job());
  workers[0].answer("two");
  expect(await second).toBe("two");
  expect(workers).toHaveLength(1);
  vi.advanceTimersByTime(999);
  expect(workers[0].terminate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  const third = model.transcribe(job());
  workers[1].answer("three");
  expect(await third).toBe("three");
});

it("never unloads the model while a recording is still being transcribed", async () => {
  const model = runner();
  const pending = model.transcribe(job());
  expect(model.idle()).toBe(false);
  vi.advanceTimersByTime(5000);
  expect(workers[0].terminate).not.toHaveBeenCalled();
  workers[0].answer("done");
  expect(await pending).toBe("done");
  expect(model.idle()).toBe(true);
});

it("fails the waiting recordings when the model crashes, and starts fresh next time", async () => {
  const model = runner();
  const pending = model.transcribe(job());
  workers[0].emit("error", new Error("out of memory"));
  await expect(pending).rejects.toThrow("out of memory");
  const next = model.transcribe(job());
  workers[1].answer("back");
  expect(await next).toBe("back");
});
