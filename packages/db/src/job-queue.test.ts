import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { outboxEvents, workspaces } from "./schema.js";
import { findBackgroundJob, insertBackgroundJob } from "./job-queue.js";
import { createMigratedDb, one } from "./pglite-test-db.js";
import { TENANT_SETTING } from "./tenancy.js";

/**
 * Issue 3.7 â€” durable job submission storage for the HTTP API.
 *
 * Against the REAL migration chain: inserts default to queued/0-attempts,
 * dedupe keys make double submits return the original row (same workspace
 * AND type required â€” anything else inserts fresh), unknown ids read back
 * null, and the app role reads only its own workspace's jobs through RLS.
 */

describe("background job queue storage", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Queue A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Queue B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("inserts queued jobs with sane defaults", async () => {
    const db = drizzlePglite(pg, { schema });
    const { job, created } = await insertBackgroundJob(db, {
      workspaceId: wsA,
      type: "import.process",
      payload: { importId: "i-1" },
    });
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(5);
    expect(job.payload).toEqual({ importId: "i-1" });
  });

  it("writes exactly one job.ready outbox event for a newly-created job", async () => {
    const db = drizzlePglite(pg, { schema });
    const first = await insertBackgroundJob(db, {
      workspaceId: wsA,
      type: "import.process",
      dedupeKey: "outbox-once",
      payload: { importId: "i-outbox" },
    });
    const second = await insertBackgroundJob(db, {
      workspaceId: wsA,
      type: "import.process",
      dedupeKey: "outbox-once",
    });
    const events = await db.select().from(outboxEvents);
    const ready = events.filter(
      (event) => event.eventType === "job.ready" && event.aggregateId === first.job.id,
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      workspaceId: wsA,
      aggregateType: "background_job",
      payload: { backgroundJobId: first.job.id },
    });
  });

  it("returns the original row for a repeated dedupe key", async () => {
    const db = drizzlePglite(pg, { schema });
    const first = await insertBackgroundJob(db, {
      workspaceId: wsA,
      type: "import.process",
      dedupeKey: "stmt-1",
    });
    const second = await insertBackgroundJob(db, {
      workspaceId: wsA,
      type: "import.process",
      dedupeKey: "stmt-1",
      payload: { ignored: true },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it("scopes dedupe keys by workspace and type", async () => {
    const db = drizzlePglite(pg, { schema });
    const otherWorkspace = await insertBackgroundJob(db, {
      workspaceId: wsB,
      type: "import.process",
      dedupeKey: "stmt-1",
    });
    expect(otherWorkspace.created).toBe(true);
    const otherType = await insertBackgroundJob(db, {
      workspaceId: wsA,
      type: "report.build",
      dedupeKey: "stmt-1",
    });
    expect(otherType.created).toBe(true);
  });

  it("finds jobs by id and misses unknown ids", async () => {
    const db = drizzlePglite(pg, { schema });
    const { job } = await insertBackgroundJob(db, { workspaceId: wsA, type: "probe" });
    expect((await findBackgroundJob(db, wsA, job.id))?.id).toBe(job.id);
    expect(await findBackgroundJob(db, wsA, "00000000-0000-4000-8000-000000000000")).toBeNull();
    // Same id, wrong workspace: invisible (RLS defense in depth starts here;
    // the row query itself is workspace-scoped too).
    expect(await findBackgroundJob(db, wsB, job.id)).toBeNull();
  });

  it("isolates job reads by tenant for the app role", async () => {
    const db = drizzlePglite(pg, { schema });
    const { job } = await insertBackgroundJob(db, { workspaceId: wsB, type: "secret.job" });
    await pg.exec("SET ROLE moneo_app");
    try {
      await pg.exec(`SET ${TENANT_SETTING} = '${wsA}'`);
      // Raw read as the runtime role in A's context: B's row is invisible.
      const seen = await pg.query(`SELECT id FROM background_jobs WHERE id = '${job.id}'`);
      expect(seen.rows).toHaveLength(0);
      await pg.exec(`SET ${TENANT_SETTING} = '${wsB}'`);
      const found = await pg.query(`SELECT id FROM background_jobs WHERE id = '${job.id}'`);
      expect(found.rows).toHaveLength(1);
    } finally {
      await pg.exec(`RESET ${TENANT_SETTING}`);
      await pg.exec("RESET ROLE");
    }
  });
});
