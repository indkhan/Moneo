// E02-S01 IO worker entry: consumes the `background` queue (concurrency 2)
// and relays the PostgreSQL outbox to BullMQ. PostgreSQL stays durable
// truth; BullMQ is at-least-once transport. Logs carry only redacted
// job/state/count metadata — never payload bodies or tenant finance data.

import { createPool } from "../../web/src/db.ts";
import { dispatchOutbox, jobsQueue, processImportJob, startJobsWorker } from "../../web/src/jobs.ts";

const databaseUrl = process.env["DATABASE_URL"] ?? "";
const redisUrl = process.env["REDIS_URL"] ?? "";
if (!databaseUrl || !redisUrl) {
  console.error("E02-S01 worker refused: DATABASE_URL and REDIS_URL are required.");
  process.exit(1);
}

const pool = createPool(databaseUrl);
const queue = jobsQueue(redisUrl);
const worker = startJobsWorker(
  redisUrl,
  async (job) => {
    const outcome = await processImportJob(pool, job.data.backgroundJobId);
    console.log(JSON.stringify({ event: "job_processed", outcome }));
    return outcome;
  },
  2,
);

worker.on("failed", (job, err) => {
  console.log(JSON.stringify({ event: "job_failed", outcome: (err as Error).message.slice(0, 80) }));
});

let stopping = false;
async function dispatchTick(): Promise<void> {
  if (stopping) return;
  try {
    const counts = await dispatchOutbox(pool, queue);
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
  await worker.close();
  await queue.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
