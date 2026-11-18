import { Worker } from "node:worker_threads";
import type { SpeechModelJob, SpeechModelRunner } from "./local";

const IDLE_UNLOAD_MS = 5 * 60_000;
type Pending = { resolve: (text: string) => void; reject: (error: Error) => void };
type Reply = { id: number; text?: string; error?: string };

export function createWorkerRunner(spawn: () => Worker, idleMs = IDLE_UNLOAD_MS): SpeechModelRunner {
  let worker: Worker | undefined, idle: NodeJS.Timeout | undefined, nextId = 0;
  const pending = new Map<number, Pending>();

  const stop = () => { const current = worker; worker = undefined; void current?.terminate(); };
  const failAll = (error: Error) => { for (const job of pending.values()) job.reject(error); pending.clear(); };
  const scheduleUnload = () => { clearTimeout(idle); if (!pending.size) idle = setTimeout(stop, idleMs).unref(); };

  function running() {
    if (worker) return worker;
    const started = spawn();
    started.on("message", ({ id, text, error }: Reply) => {
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      if (typeof text === "string") job.resolve(text); else job.reject(new Error(error ?? "The speech model failed"));
      scheduleUnload();
    });
    started.on("error", (error: Error) => { if (worker === started) worker = undefined; failAll(error); });
    started.on("exit", () => { if (worker === started) worker = undefined; failAll(new Error("The speech model stopped")); });
    worker = started;
    return started;
  }

  return {
    idle: () => pending.size === 0,
    transcribe(job: SpeechModelJob) {
      clearTimeout(idle);
      const id = nextId++;
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        running().postMessage({ id, job }, [job.samples.buffer as ArrayBuffer]);
      });
    },
  };
}

export const workerRunner = createWorkerRunner(() => new Worker(new URL("./local-worker.mjs", import.meta.url)));
