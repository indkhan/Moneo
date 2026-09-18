// E02-S02 fault-injection child. Spawned by test/job-recovery.test.ts through
// vitest (same pattern as proof/durable/kill-child.ts) so TS transforms
// apply; never run directly without the E02_FAULT_* env contract (fails
// closed). Performs fenced phases up to the requested kill point, prints the
// marker, then hangs until the parent SIGKILLs it — proving recovery from a
// real dead process at each persisted boundary with no leaked state.

import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { resolveJobRoute } from "../../apps/web/src/jobs.ts";
import { checkpointAttempt, claimAttempt, commitEffectFenced } from "../../apps/web/src/job-recovery.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`E02-S02 fault child prerequisite missing: ${name}.`);
  return value;
}

const NEVER: Promise<never> = new Promise(() => undefined);

describe("e02-s02 fault child", () => {
  it("advances to the kill phase then dies", async () => {
    const dbUrl = required("E02_FAULT_DB_URL");
    const jobId = required("E02_FAULT_JOB");
    const phase = required("E02_FAULT_PHASE");
    const leaseMs = Number(required("E02_FAULT_LEASE_MS"));
    if (!["after-claim", "after-checkpoint", "after-effect"].includes(phase)) {
      throw new Error(`E02-S02 fault child refused: unknown phase ${phase}.`);
    }
    const pool = new Pool({ connectionString: dbUrl, max: 1 });
    try {
      const route = await resolveJobRoute(pool, jobId);
      expect(route).not.toBeNull();
      const full = { ...route!, jobId };
      const claim = await claimAttempt(pool, full, "fault-child", leaseMs);
      const pick = { attemptId: claim.attemptId, generation: claim.generation };
      console.log("after-claim");
      if (phase === "after-claim") await NEVER;
      const first = await checkpointAttempt(pool, full, pick, "checkpoint-a");
      expect(first.ok).toBe(true);
      console.log("after-checkpoint");
      if (phase === "after-checkpoint") await NEVER;
      const published = await commitEffectFenced(pool, full, pick);
      expect(published.ok).toBe(true);
      console.log("after-effect");
      if (phase === "after-effect") await NEVER;
    } finally {
      await pool.end();
    }
  }, 30_000);
});
