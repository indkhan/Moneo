// E04-S02 fault-injection child. Spawned by test/chat.test.ts through vitest
// (same pattern as test/helpers/job-fault-child.test.ts) so TS transforms
// apply; never run directly without the E04_CHAT_FAULT_* env contract (fails
// closed). Drives the exact worker claim path (claimChatGeneration) up to the
// requested kill point, prints the marker, then hangs until the parent
// SIGKILLs it — proving recovery from a real dead process at each persisted
// boundary with at most one published turn and no leaked state.

import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { issuePermit } from "../../apps/web/src/ai-policy.ts";
import { reserveDispatch } from "../../apps/web/src/ai-dispatch.ts";
import { claimChatGeneration } from "../../apps/web/src/chat.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`E04-S02 fault child prerequisite missing: ${name}.`);
  return value;
}

const NEVER: Promise<never> = new Promise(() => undefined);

describe("e04-s02 fault child", () => {
  it("advances to the kill phase then dies", async () => {
    const dbUrl = required("E04_CHAT_DB_URL");
    const jobId = required("E04_CHAT_JOB");
    const phase = required("E04_CHAT_PHASE");
    const leaseMs = Number(required("E04_CHAT_LEASE_MS"));
    if (!["after-claim", "after-output"].includes(phase)) {
      throw new Error(`E04-S02 fault child refused: unknown phase ${phase}.`);
    }
    const pool = new Pool({ connectionString: dbUrl, max: 2 });
    try {
      const claimed = await claimChatGeneration(pool, jobId, { workerId: "fault-child", leaseMs });
      expect(claimed).not.toBeNull();
      const { route, claim, input, attemptId } = claimed!;
      console.log("after-claim");
      if (phase === "after-claim") await NEVER;
      // after-output: fresh permit + S01 reservation + provider output
      // persisted on this attempt (fenced by the live generation), then hang
      // before S01 settlement and publish. Recovery must mark this attempt
      // interrupted and publish exactly once under a new generation.
      const workerClaims = { userId: route.acceptedBy, workspaceId: route.workspaceId };
      const text = required("E04_CHAT_TEXT");
      const permit = await issuePermit(pool, workerClaims, "chat-generation");
      const reserved = await reserveDispatch(pool, workerClaims, {
        idempotencyKey: `chat:${attemptId}`,
        permitId: permit.id,
        route: "development",
        purpose: "chat-generation",
        requestText: `chat-generation:${input.threadId}:${input.assistantTurnId}`,
        inputEstimate: 2000,
        outputCeiling: 2000,
      });
      const client = await pool.connect();
      try {
        // Direct reads/writes need the tenant context in one transaction:
        // FORCE RLS filters unscoped access to zero rows by design, and a
        // transaction-local setting outside BEGIN dies with its statement.
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_workspace', $1, true), set_config('app.current_user', $2, true)", [
          route.workspaceId,
          route.acceptedBy,
        ]);
        const live = await client.query("SELECT attempt_generation, status FROM background_jobs WHERE workspace_id = $1 AND id = $2", [
          route.workspaceId,
          jobId,
        ]);
        expect((live.rows[0] as { attempt_generation: string }).attempt_generation).toBe(String(claim.generation));
        await client.query("UPDATE chat_attempts SET output_text = $3, reservation_id = $4 WHERE workspace_id = $1 AND id = $2 AND status = 'running'", [
          route.workspaceId,
          attemptId,
          text,
          reserved.id,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch { /* preserve */ }
        throw err;
      } finally {
        client.release();
      }
      console.log("after-output");
      await NEVER;
    } finally {
      await pool.end();
    }
  }, 30_000);
});
