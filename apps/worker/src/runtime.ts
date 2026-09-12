import { Queue, Worker, type Job } from "bullmq";
import type Redis from "ioredis";
import type { Logger } from "pino";

export const QUEUE_NAME = "moneo-maintenance";

export interface WorkerHandles {
  queue: Queue;
  worker: Worker;
}

/**
 * Epoch 0 skeleton: no business jobs yet. A single maintenance queue proves
 * the Postgres + Redis + BullMQ wiring and the graceful-shutdown path.
 */
export function createWorkerRuntime(connection: Redis, logger: Logger): WorkerHandles {
  const queue = new Queue(QUEUE_NAME, { connection });
  const worker = new Worker(
    QUEUE_NAME,
    (job: Job) => {
      logger.info({ jobId: job.id, jobName: job.name }, "worker job received (noop)");
      return Promise.resolve({ ok: true });
    },
    {
      connection,
      concurrency: 2,
      lockDuration: 30_000,
    },
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "worker job completed");
  });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "worker job failed");
  });
  worker.on("error", (err) => {
    logger.error({ err: err.message }, "worker error");
  });

  return { queue, worker };
}
