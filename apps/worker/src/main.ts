// E02-S01 IO worker entry (E02-S02: fenced phased handler + configured
// lease): consumes the `background` queue (concurrency 2) and relays the
// PostgreSQL outbox to BullMQ. PostgreSQL stays durable truth; BullMQ is
// at-least-once transport. Logs carry only redacted job/state/count
// metadata — never payload bodies or tenant finance data.
//
// The service factory is importable so the S02 suite can drive a real
// BullMQ delivery end to end; signal wiring runs only under the entrypoint
// guard below.

import { hostname } from "node:os";
import type { Pool } from "pg";
import type { Queue, Worker } from "bullmq";
import { createPool } from "../../web/src/db.ts";
import { dispatchOutbox, jobsQueue, processImportJob, startJobsWorker, type JobPayload } from "../../web/src/jobs.ts";
import { parseLeaseMsEnv } from "../../web/src/job-recovery.ts";

export type WorkerService = {
  pool: Pool;
  queue: Queue<JobPayload>;
  worker: Worker<JobPayload, string>;
  dispatchOnce: () => Promise<{ enqueued: number; skipped: number }>;
  close: () => Promise<void>;
};

export function createWorkerService(opts: { databaseUrl: string; redisUrl: string; leaseMs?: number; workerId?: string }): WorkerService {
  const { databaseUrl, redisUrl } = opts;
  if (!databaseUrl || !redisUrl) throw new Error("E02-S01 worker refused: DATABASE_URL and REDIS_URL are required.");
  const leaseMs = opts.leaseMs ?? parseLeaseMsEnv(process.env["JOB_LEASE_MS"]);
  const workerId = opts.workerId ?? `jobs-worker-${hostname()}-${process.pid}`.slice(0, 120);
  const pool = createPool(databaseUrl);
  const queue = jobsQueue(redisUrl);
  const worker = startJobsWorker(
    redisUrl,
    async (job) => {
      let outcome: string;
      try {
        outcome = await processImportJob(pool, job.data.backgroundJobId, {
          workerId,
          leaseMs,
          bullmqJobId: job.id,
        });
      } catch (err) {
        if ((err as { code?: string }).code === "lease_held") {
          // A live attempt holds the job: not a failure, just not ours now.
          // Throwing would fail the BullMQ record; returning keeps it
          // completed while PG truth (and the lease) decides redelivery.
          console.log(JSON.stringify({ event: "job_deferred", reason: "lease_held" }));
          return "lease-held-retry-later";
        }
        throw err;
      }
      console.log(JSON.stringify({ event: "job_processed", outcome }));
      return outcome;
    },
    2,
  );

  worker.on("failed", () => {
    // Redacted: BullMQ failure reasons can echo transport internals; the
    // durable state lives in PG and is read from there.
    console.log(JSON.stringify({ event: "job_failed" }));
  });

  return {
    pool,
    queue,
    worker,
    dispatchOnce: () => dispatchOutbox(pool, queue),
    close: async () => {
      await worker.close();
      await queue.close();
      await pool.end();
    },
  };
}

// CommonJS-safe entrypoint guard (this file compiles to CJS: no
// import.meta): signal wiring + ticking run only for `node .../main.js`,
// never when the suite imports the factory.
const invokedAs = (process.argv[1] ?? "").replace(/\\/g, "/");
const isEntrypoint = invokedAs.endsWith("/apps/worker/src/main.ts") || invokedAs.endsWith("/worker/src/main.js");

if (isEntrypoint) {
  const databaseUrl = process.env["DATABASE_URL"] ?? "";
  const redisUrl = process.env["REDIS_URL"] ?? "";
  let service: WorkerService;
  try {
    service = createWorkerService({ databaseUrl, redisUrl });
  } catch (err) {
    console.error(`E02-S02 worker refused: ${(err as Error).message}`);
    process.exit(1);
  }
  let stopping = false;
  async function dispatchTick(): Promise<void> {
    if (stopping) return;
    try {
      const counts = await service.dispatchOnce();
      if (counts.enqueued > 0 || counts.skipped > 0) {
        console.log(JSON.stringify({ event: "dispatch", enqueued: counts.enqueued, skipped: counts.skipped }));
      }
    } catch {
      // Transient dispatch failure: the next tick retries; never crash the
      // worker on a single pass (redacted: no payload or URL detail).
      console.log(JSON.stringify({ event: "dispatch_error" }));
    }
  }

  const timer = setInterval(() => void dispatchTick(), 1000);
  timer.unref?.();
  void dispatchTick();

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    console.log(JSON.stringify({ event: "shutdown", signal }));
    await service.close();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
