import { Pool } from "pg";
import Redis from "ioredis";
import { loadEnv } from "@moneo/shared/env";
import { createLogger } from "@moneo/shared/logging";
import { startTelemetry, shutdownTelemetry } from "./telemetry.js";
import { createWorkerRuntime } from "./runtime.js";

async function main(): Promise<void> {
  const env = loadEnv();
  startTelemetry(env);
  const logger = createLogger({ service: "worker", env });

  const pgPool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  // Fail fast when dependencies are unreachable.
  await pgPool.query("SELECT 1");
  await redis.ping();
  logger.info({ release: env.APP_RELEASE }, "worker connected to postgres + redis");

  const { queue, worker } = createWorkerRuntime(redis, logger);
  logger.info("worker runtime started");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown initiated");
    // Bounded graceful close: stop taking new jobs, drain in-flight, then
    // release Postgres/Redis. Prevents stalled-job churn on deploy.
    const closeTimeout = new Promise((resolve) => setTimeout(resolve, 15_000));
    await Promise.race([
      (async () => {
        await worker.close();
        await queue.close();
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
