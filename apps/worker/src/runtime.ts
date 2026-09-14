import { Queue, Worker, type Job } from "bullmq";
import type Redis from "ioredis";
import type { Logger } from "pino";
import type { OutboxJobData, OutboxTransport } from "./outbox.js";

export const QUEUE_NAME = "moneo-maintenance";

export interface WorkerHandles {
  queue: Queue;
  worker: Worker;
}

export interface DurableJobExecutor {
  (jobId: string, workspaceId: string, workerId: string): Promise<unknown>;
}

export interface WorkerRuntimeOptions {
  executeDurableJob?: DurableJobExecutor;
  workerId?: string;
}

type QueuePublisher = {
  add(name: string, data: OutboxJobData, options: { jobId: string }): Promise<unknown>;
};

/** BullMQ transport used by the PostgreSQL outbox dispatcher. */
export function createBullMqOutboxTransport(queue: QueuePublisher): OutboxTransport {
  return {
    async publish(jobId, data) {
      await queue.add("outbox-delivery", data, { jobId });
    },
  };
}

/**
 * Epoch 0 skeleton: no business jobs yet. A single maintenance queue proves
 * the Postgres + Redis + BullMQ wiring and the graceful-shutdown path.
 */
export function createWorkerRuntime(
  connection: Redis,
  logger: Logger,
  options: WorkerRuntimeOptions = {},
): WorkerHandles {
  const queue = new Queue(QUEUE_NAME, { connection });
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const data = job.data as { payload?: { backgroundJobId?: unknown }; workspaceId?: unknown };
      const backgroundJobId = data.payload?.backgroundJobId;
      if (
        !options.executeDurableJob ||
        typeof backgroundJobId !== "string" ||
        typeof data.workspaceId !== "string"
      ) {
        throw new Error("outbox delivery has no configured durable-job executor");
      }
      const workerId = options.workerId ?? `worker-${process.pid}`;
      logger.info({ jobId: job.id, backgroundJobId, workerId }, "executing durable job delivery");
      return options.executeDurableJob(backgroundJobId, data.workspaceId, workerId);
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
