import { Pool } from "pg";
import Redis from "ioredis";
import { loadEnv } from "@moneo/shared/env";
import { createLogger } from "@moneo/shared/logging";
import { startTelemetry, shutdownTelemetry } from "./telemetry.js";
import { createBullMqOutboxTransport, createWorkerRuntime } from "./runtime.js";
import { createDurableJobExecutor } from "./durable-executor.js";
import { IMPORT_JOB_TYPE } from "./import-workflow.js";
import { createProductionImportHandler } from "./import-adapter.js";
import { createConfiguredS3ObjectStore } from "@moneo/shared/uploads";
import { createPgOutboxStore } from "./outbox-store.js";
import { dispatchOutboxBatch } from "./outbox.js";
import { startOutboxDispatcher } from "./dispatcher.js";

async function main(): Promise<void> {
  const env = loadEnv();
  startTelemetry(env);
  const logger = createLogger({ service: "worker", env });

  if (!env.OUTBOX_DATABASE_URL) {
    throw new Error("OUTBOX_DATABASE_URL is required for the global outbox dispatcher");
  }

  const pgPool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  const outboxPool = new Pool({ connectionString: env.OUTBOX_DATABASE_URL, max: 2 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  // Fail fast when dependencies are unreachable.
  await pgPool.query("SELECT 1");
  await outboxPool.query("SELECT 1");
  await redis.ping();
  logger.info({ release: env.APP_RELEASE }, "worker connected to postgres + redis");

  const objectStore = createConfiguredS3ObjectStore({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  });
  const handlers = new Map([[IMPORT_JOB_TYPE, createProductionImportHandler(objectStore)]]);
  const { queue, worker } = createWorkerRuntime(redis, logger, {
    executeDurableJob: createDurableJobExecutor(handlers),
    workerId: `worker-${process.pid}`,
  });
  const outboxStore = createPgOutboxStore(outboxPool);
  const outboxTransport = createBullMqOutboxTransport(queue);
  const stopDispatcher = startOutboxDispatcher(
    async () => {
      const outcome = await dispatchOutboxBatch(outboxStore, outboxTransport);
      if (outcome.claimed > 0) logger.info(outcome, "outbox batch dispatched");
    },
    (error) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "outbox dispatch failed",
      );
    },
  );
  logger.info("worker runtime started");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopDispatcher();
    logger.info({ signal }, "shutdown initiated");
    // Bounded graceful close: stop taking new jobs, drain in-flight, then
    // release Postgres/Redis. Prevents stalled-job churn on deploy.
    const closeTimeout = new Promise((resolve) => setTimeout(resolve, 15_000));
    await Promise.race([
      (async () => {
        await worker.close();
        await queue.close();
        await outboxPool.end();
        await pgPool.end();
        redis.disconnect();
      })(),
      closeTimeout,
    ]);
    if (!worker.isRunning()) logger.info("worker closed gracefully");
    await shutdownTelemetry().catch(() => undefined);
    logger.info("worker shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Keep the process alive; BullMQ owns the event loop from here.
  await new Promise(() => undefined);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
