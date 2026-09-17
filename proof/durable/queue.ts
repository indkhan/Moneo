// E00-S04 BullMQ transport. Redis is execution transport only: payloads carry
// bare references (tenant + operation identity, per architecture section 181)
// and every handler revalidates against PostgreSQL before publishing effects.

import { Queue, Worker, type Processor } from "bullmq";
import { Redis } from "ioredis";
import type { ProofEnv } from "./env.ts";

export const QUEUE_NAME = "e00s04-apply";
export const QUEUE_PREFIX = "moneo:e00s04";

export type ApplyJobData = { operationId: string; tenantId: string };

/** Deterministic transport identity: re-enqueue dedups while the record lives. */
export function jobKey(operationId: string): string {
  return `e00s04-${operationId}`;
}

function redisConnection(env: ProofEnv): Redis {
  // Parsed explicitly (never logged): the suite DB keeps proof keys off any
  // other local database on the same disposable server.
  const u = new URL(env.redisUrl);
  return new Redis({
    host: u.hostname,
    port: Number(u.port || "6379"),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: env.redisDb,
    // BullMQ workers use blocking commands: no per-request retry cap.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 8000,
  });
}

export function proofRedis(env: ProofEnv, opts?: { failFast?: boolean }): Redis {
  const client = redisConnection(env);
  if (opts?.failFast) {
    // Probe connections must fail closed quickly, never retry forever.
    client.options.retryStrategy = () => null;
    client.options.connectTimeout = 5000;
  }
  return client;
}

export function applyQueue(env: ProofEnv): Queue<ApplyJobData> {
  return new Queue<ApplyJobData>(QUEUE_NAME, {
    connection: redisConnection(env),
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 60 },
      removeOnFail: { age: 300 },
    },
  });
}

export function applyWorker(
  env: ProofEnv,
  processor: Processor<ApplyJobData, string>,
  opts?: { concurrency?: number },
): Worker<ApplyJobData, string> {
  const worker = new Worker<ApplyJobData, string>(QUEUE_NAME, processor, {
    connection: redisConnection(env),
    prefix: QUEUE_PREFIX,
    concurrency: opts?.concurrency ?? 10,
  });
  // Surface transport errors to the test instead of crashing the process.
  worker.on("error", () => undefined);
  return worker;
}
