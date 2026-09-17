// E00-S04 durable-effects proof tests.
//
// Real PostgreSQL (dedicated disposable database) + real Redis/BullMQ
// (dedicated logical DB on the local dev server). Nothing is mocked: every
// fault point below exercises the same claim/publish functions the live
// BullMQ processor uses. The suite fails closed when services are missing;
// a skipped service is not a pass. Operation UUIDs are never logged.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acceptCommand,
  cancelCommand,
  counterValue,
  ProofError,
} from "../proof/durable/commands.ts";
import {
  ensureProofDatabase,
  migrate,
  proofPool,
  truncateAll,
} from "../proof/durable/db.ts";
import {
  dispatchOutbox,
  enqueueApply,
  reconcile,
} from "../proof/durable/dispatch.ts";
import { loadProofEnv, type ProofEnv } from "../proof/durable/env.ts";
import {
  applyQueue,
  applyWorker,
  proofRedis,
} from "../proof/durable/queue.ts";
import {
  claimAttempt,
  processApplyJob,
  publishEffect,
} from "../proof/durable/worker.ts";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const COUNTER = "main";

let env: ProofEnv;
let pool: Pool;

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function effectCount(tenantId: string): Promise<number> {
  const r = await pool.query("SELECT count(*)::int AS n FROM proof_effects WHERE tenant_id = $1", [
    tenantId,
  ]);
  return r.rows[0].n as number;
}

async function attemptStatuses(operationId: string): Promise<string[]> {
  const r = await pool.query(
    "SELECT status FROM proof_attempts WHERE operation_id = $1 ORDER BY attempt_no",
    [operationId],
  );
  return r.rows.map((row) => row.status as string);
}

/** Drain the live queue until PG (the truth) shows the expected counters. */
async function drainUntil(
  counters: Record<string, number>,
  opts?: { leaseMs?: number; concurrency?: number; timeoutMs?: number },
): Promise<void> {
  const leaseMs = opts?.leaseMs ?? 5000;
  const worker = applyWorker(
    env,
    async (job) =>
      processApplyJob(pool, job.data.tenantId, job.data.operationId, `proof-worker`, leaseMs),
    { concurrency: opts?.concurrency ?? 10 },
  );
  await worker.waitUntilReady();
  try {
    await waitFor(async () => {
      for (const [tenant, want] of Object.entries(counters)) {
        if ((await counterValue(pool, tenant, COUNTER)) !== want) return false;
      }
      return true;
    }, opts?.timeoutMs ?? 30000, `counters ${JSON.stringify(counters)}`);
  } finally {
    await worker.close();
  }
}

beforeAll(async () => {
  env = loadProofEnv();
  await ensureProofDatabase(env);
  pool = proofPool(env);
  // Fail closed with a redacted hint (host/db names only, never credentials).
  try {
    await pool.query("SELECT 1");
  } catch {
    throw new Error("E00-S04 prerequisite missing: PostgreSQL unreachable for the proof database.");
  }
  const redis = proofRedis(env, { failFast: true });
  try {
    await redis.ping();
  } catch {
    throw new Error("E00-S04 prerequisite missing: local Redis unreachable (start redis-server).");
  } finally {
    redis.disconnect();
  }
  await migrate(pool);
}, 120000);

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  // Only the suite-owned logical DB on the local disposable server is flushed.
  const redis = proofRedis(env);
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}, 30000);

describe("E00-S04 durable effects", () => {
  it("duplicate delivery and concurrent submissions apply exactly once; incompatible reuse is rejected", async () => {
    const operationId = randomUUID();
    // 20 concurrent identical submissions converge on one accepted command.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        acceptCommand(pool, TENANT_A, operationId, { counterId: COUNTER }),
      ),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);

    const queue = applyQueue(env);
    try {
      await dispatchOutbox(pool, queue);
      // Duplicate transport delivery of the same logical job.
      await dispatchOutbox(pool, queue);
      await drainUntil({ [TENANT_A]: 1 });
      expect(await effectCount(TENANT_A)).toBe(1);
      expect(await counterValue(pool, TENANT_A, COUNTER)).toBe(1);
    } finally {
      await queue.close();
    }

    // Same identity, incompatible payload: rejected, never merged.
    await expect(
      acceptCommand(pool, TENANT_A, operationId, { counterId: "other" }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_REUSE" });
    // Same identity, foreign tenant: rejected without disclosure.
    await expect(
      acceptCommand(pool, TENANT_B, operationId, { counterId: COUNTER }),
    ).rejects.toMatchObject({ code: "TENANT_MISMATCH" });
    expect(await counterValue(pool, TENANT_A, COUNTER)).toBe(1);
    expect(await counterValue(pool, TENANT_B, COUNTER)).toBe(0);
  }, 60000);

  it("crash before dispatch loses nothing", async () => {
    const operationId = randomUUID();
    await acceptCommand(pool, TENANT_A, operationId, { counterId: COUNTER });
    // Worker dies before ever dispatching: reconciler relays from PG truth.
    const queue = applyQueue(env);
    try {
      const rec = await reconcile(pool, queue);
      expect(rec.dispatched).toBe(1);
      await drainUntil({ [TENANT_A]: 1 });
      expect(await effectCount(TENANT_A)).toBe(1);
    } finally {
      await queue.close();
    }
  }, 60000);

  it("crash after enqueue but before outbox marking duplicates nothing", async () => {
    const operationId = randomUUID();
    await acceptCommand(pool, TENANT_A, operationId, { counterId: COUNTER });
    const queue = applyQueue(env);
    try {
      // Crash point: transport holds the job, PG still shows unpublished.
      await enqueueApply(queue, TENANT_A, operationId);
      const second = await dispatchOutbox(pool, queue);
      expect(second.enqueued).toBe(1);
      await drainUntil({ [TENANT_A]: 1 });
      expect(await effectCount(TENANT_A)).toBe(1);
      expect(await counterValue(pool, TENANT_A, COUNTER)).toBe(1);
    } finally {
      await queue.close();
    }
  }, 60000);

  it("crash during execution recovers via lease expiry with a fenced stale attempt", async () => {
    const operationId = randomUUID();
    await acceptCommand(pool, TENANT_A, operationId, { counterId: COUNTER });
    const queue = applyQueue(env);
    try {
      await dispatchOutbox(pool, queue);
      // Worker claims, then dies before publishing (300 ms test lease).
      const stale = await claimAttempt(pool, TENANT_A, operationId, "dying-worker", 300);
      await new Promise((r) => setTimeout(r, 600));
      const rec = await reconcile(pool, queue);
      expect(rec.requeuedStalled).toBe(1);
      // Replacement claims a new generation; the dead worker's late publish
      // is fenced and recorded STALE while the new attempt succeeds.
      const fresh = await claimAttempt(pool, TENANT_A, operationId, "recovery-worker", 5000);
      expect(fresh.generation).toBe(stale.generation + 1);
      expect(await publishEffect(pool, TENANT_A, operationId, stale)).toEqual({
        ok: false,
        reason: "STALE_ATTEMPT",
      });
      expect(await publishEffect(pool, TENANT_A, operationId, fresh)).toEqual({ ok: true });
      expect(await counterValue(pool, TENANT_A, COUNTER)).toBe(1);
      expect(await attemptStatuses(operationId)).toEqual(["STALE", "SUCCEEDED"]);
    } finally {
      await queue.close();
    }
  }, 60000);

  it("crash after effect commit is a duplicate-delivery no-op on recovery", async () => {
    const operationId = randomUUID();
    await acceptCommand(pool, TENANT_A, operationId, { counterId: COUNTER });
    const queue = applyQueue(env);
    try {
      await dispatchOutbox(pool, queue);
      // Effect commits, then the worker dies before acknowledging the queue.
      const claim = await claimAttempt(pool, TENANT_A, operationId, "unlucky-worker", 5000);
      expect(await publishEffect(pool, TENANT_A, operationId, claim)).toEqual({ ok: true });
      // BullMQ redelivers: PG already SUCCEEDED, so no second effect.
      expect(await processApplyJob(pool, TENANT_A, operationId, "redelivery-worker", 5000)).toBe(
        "duplicate-terminal-noop",
      );
      await drainUntil({ [TENANT_A]: 1 });
      expect(await effectCount(TENANT_A)).toBe(1);
    } finally {
      await queue.close();
    }
  }, 60000);

  it("complete Redis transport loss is restored by the PG reconciler", async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    for (const id of ids) await acceptCommand(pool, TENANT_A, id, { counterId: COUNTER });
    const queue = applyQueue(env);
    try {
      await dispatchOutbox(pool, queue);
      // Total loss of the dedicated disposable Redis DB (never a shared one).
      const redis = proofRedis(env);
      try {
        await redis.flushdb();
      } finally {
        redis.disconnect();
      }
      const rec = await reconcile(pool, queue);
      // 5 published-but-unstarted jobs rebuilt purely from PG rows.
      expect(rec.requeuedUnstarted).toBe(5);
      await drainUntil({ [TENANT_A]: 5 });
      expect(await effectCount(TENANT_A)).toBe(5);
    } finally {
      await queue.close();
    }
  }, 90000);

  it("a stalled old attempt cannot publish after reclaim; cancel wins and blocks later publication", async () => {
    const fencedId = randomUUID();
    await acceptCommand(pool, TENANT_A, fencedId, { counterId: COUNTER });
    const old = await claimAttempt(pool, TENANT_A, fencedId, "stalled-worker", 300);
    await new Promise((r) => setTimeout(r, 600));
    const replacement = await claimAttempt(pool, TENANT_A, fencedId, "new-worker", 5000);
    expect(await publishEffect(pool, TENANT_A, fencedId, old)).toEqual({
      ok: false,
      reason: "STALE_ATTEMPT",
    });
    expect(await publishEffect(pool, TENANT_A, fencedId, replacement)).toEqual({ ok: true });

    const cancelledId = randomUUID();
    await acceptCommand(pool, TENANT_A, cancelledId, { counterId: COUNTER });
    const doomed = await claimAttempt(pool, TENANT_A, cancelledId, "doomed-worker", 5000);
    const cancel = await cancelCommand(pool, TENANT_A, cancelledId);
    expect(cancel.effectApplied).toBe(false);
    // The in-flight worker's late publish is blocked and recorded BLOCKED.
    expect(await publishEffect(pool, TENANT_A, cancelledId, doomed)).toEqual({
      ok: false,
      reason: "CANCELLED",
    });
    // Forged cross-tenant publish discloses nothing and changes nothing.
    expect(
      await publishEffect(pool, TENANT_B, fencedId, {
        attemptId: randomUUID(),
        generation: 999,
      }),
    ).toEqual({ ok: false, reason: "STALE_ATTEMPT" });

    const queue = applyQueue(env);
    try {
      // Reconciler + live worker must not resurrect cancelled work.
      await reconcile(pool, queue);
      await drainUntil({ [TENANT_A]: 1 });
      expect(await counterValue(pool, TENANT_A, COUNTER)).toBe(1);
      expect(await attemptStatuses(cancelledId)).toEqual(["BLOCKED"]);
    } finally {
      await queue.close();
    }
  }, 90000);

  it("cancel after success preserves history and reports the committed effect", async () => {
    const operationId = randomUUID();
    await acceptCommand(pool, TENANT_A, operationId, { counterId: COUNTER });
    const queue = applyQueue(env);
    try {
      await dispatchOutbox(pool, queue);
      await drainUntil({ [TENANT_A]: 1 });
      const cancel = await cancelCommand(pool, TENANT_A, operationId);
      expect(cancel.effectApplied).toBe(true);
      const state = await pool.query("SELECT state FROM proof_jobs WHERE operation_id = $1", [
        operationId,
      ]);
      expect(state.rows[0].state).toBe("SUCCEEDED");
    } finally {
      await queue.close();
    }
  }, 60000);

  it("second tenant flows stay isolated from the first tenant", async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    await acceptCommand(pool, TENANT_A, idA, { counterId: COUNTER });
    await acceptCommand(pool, TENANT_B, idB, { counterId: COUNTER });
    // Cross-tenant claim observes nothing.
    await expect(claimAttempt(pool, TENANT_B, idA, "snooping-worker", 5000)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const queue = applyQueue(env);
    try {
      await dispatchOutbox(pool, queue);
      await drainUntil({ [TENANT_A]: 1, [TENANT_B]: 1 });
      expect(await effectCount(TENANT_A)).toBe(1);
      expect(await effectCount(TENANT_B)).toBe(1);
    } finally {
      await queue.close();
    }
  }, 60000);

  it("100 stalled commands recover within 30 seconds with zero missing/duplicate effects", async () => {
    const N = 100;
    const ids = Array.from({ length: N }, () => randomUUID());
    for (const id of ids) await acceptCommand(pool, TENANT_A, id, { counterId: COUNTER });
    // Tenant-B sentinel detects unscoped state changes during mass recovery.
    const sentinelB = randomUUID();
    await acceptCommand(pool, TENANT_B, sentinelB, { counterId: COUNTER });

    const queue = applyQueue(env);
    try {
      await dispatchOutbox(pool, queue, N + 1);
      // Every worker dies right after claiming: deliberately short 500 ms
      // test lease (not a production value), then the suite waits it out.
      for (const id of ids) await claimAttempt(pool, TENANT_A, id, "mass-death", 500);
      await new Promise((r) => setTimeout(r, 800));

      const started = Date.now();
      const rec = await reconcile(pool, queue, N + 1);
      expect(rec.requeuedStalled).toBe(N);
      await drainUntil({ [TENANT_A]: N, [TENANT_B]: 1 }, { timeoutMs: 60000, concurrency: 10 });
      const elapsedMs = Date.now() - started;

      expect(elapsedMs).toBeLessThan(30000);
      expect(await effectCount(TENANT_A)).toBe(N);
      expect(await counterValue(pool, TENANT_A, COUNTER)).toBe(N);
      expect(await counterValue(pool, TENANT_B, COUNTER)).toBe(1);
      // No missing, no duplicates: every operation has exactly one effect.
      const orphans = await pool.query(
        "SELECT (SELECT count(*) FROM proof_commands WHERE tenant_id = $1) AS cmds, (SELECT count(*) FROM proof_effects WHERE tenant_id = $1) AS effs",
        [TENANT_A],
      );
      expect(Number(orphans.rows[0].cmds)).toBe(N);
      expect(Number(orphans.rows[0].effs)).toBe(N);
      // Measurement for the ledger (proof-output is gitignored).
      process.stdout.write(`E00-S04 mass recovery: ${N} commands in ${elapsedMs} ms\n`);
    } finally {
      await queue.close();
    }
  }, 120000);
});
