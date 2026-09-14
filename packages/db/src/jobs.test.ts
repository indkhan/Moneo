import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { backgroundJobAttempts, backgroundJobs, scheduledTasks, workspaces } from "./schema.js";
import { createMigratedDb, expectDbError, one, tableNames } from "./pglite-test-db.js";
import { isUuidV7, uuidv7 } from "./uuid.js";
import { TENANT_SETTING } from "./tenancy.js";

/**
 * Issue 2.4 â€” durable job and schedule schema.
 *
 * Applies the REAL shipped chain (0000â€“0006) to PGlite and proves:
 * table shape + defaults, status allowlists, orphan rejection, cascade
 * jobâ†’attempts and workspaceâ†’everything, idempotent enqueue via
 * (workspace_id, type, dedupe_key) with NULL keys exempt, the pickup index
 * the worker will claim through, attempt numbering uniqueness, the global
 * (RLS-free) schedule registry, and tenant isolation for jobs/attempts.
 */
describe("durable job and schedule schema (migration 0006)", () => {
  let pg!: PGlite;

  let wsA!: string;
  let wsB!: string;

  async function q<T>(sqlText: string, params: unknown[] = []): Promise<T[]> {
    const result =
      params.length > 0
        ? await pg.query<T>(sqlText, params as never[])
        : await pg.query<T>(sqlText);
    return result.rows;
  }

  async function qRaw(sqlText: string, params: unknown[] = []) {
    return params.length > 0 ? pg.query(sqlText, params as never[]) : pg.query(sqlText);
  }

  async function asApp<T>(workspaceId: string | null, fn: () => Promise<T>): Promise<T> {
    await pg.exec("SET ROLE moneo_app");
    try {
      if (workspaceId === null) {
        await pg.exec(`RESET ${TENANT_SETTING}`);
      } else {
        await pg.exec(`SET ${TENANT_SETTING} = '${workspaceId}'`);
      }
      return await fn();
    } finally {
      await pg.exec(`RESET ${TENANT_SETTING}`);
      await pg.exec("RESET ROLE");
    }
  }

  const count = async (table: string, where = "", params: unknown[] = []) =>
    one(await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} ${where}`, params)).n;

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Jobs A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Jobs B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates the three tables with UUIDv7 defaults and sane initial state", async () => {
    const tables = await tableNames(pg);
    expect(tables).toContain("background_jobs");
    expect(tables).toContain("background_job_attempts");
    expect(tables).toContain("scheduled_tasks");

    const db = drizzlePglite(pg, { schema });
    const job = one(
      await db.insert(backgroundJobs).values({ workspaceId: wsA, type: "probe" }).returning(),
    );
    expect(isUuidV7(job.id)).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.payload).toEqual({});
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(5);
    expect(job.result).toBeNull();
    expect(job.runAfter).toBeInstanceOf(Date);

    const attempt = one(
      await db
        .insert(backgroundJobAttempts)
        .values({ jobId: job.id, workspaceId: wsA, attemptNumber: 1 })
        .returning(),
    );
    expect(isUuidV7(attempt.id)).toBe(true);
    expect(attempt.status).toBe("started");
    expect(attempt.startedAt).toBeInstanceOf(Date);
    expect(attempt.finishedAt).toBeNull();
  });

  it("rejects unknown job/attempt statuses", async () => {
    const db = drizzlePglite(pg, { schema });
    await expectDbError(
      db.insert(backgroundJobs).values({ workspaceId: wsA, type: "bad", status: "teleported" }),
      /violates check constraint "background_jobs_status_check"/,
    );
    const job = one(
      await db.insert(backgroundJobs).values({ workspaceId: wsA, type: "ok" }).returning(),
    );
    await expectDbError(
      db
        .insert(backgroundJobAttempts)
        .values({ jobId: job.id, workspaceId: wsA, attemptNumber: 1, status: "napping" }),
      /violates check constraint "background_job_attempts_status_check"/,
    );
    for (const status of ["queued", "running", "succeeded", "failed", "cancelled"] as const) {
      await db.insert(backgroundJobs).values({ workspaceId: wsA, type: `t.${status}`, status });
    }
    for (const status of ["started", "succeeded", "failed"] as const) {
      const j = one(
        await db
          .insert(backgroundJobs)
          .values({ workspaceId: wsA, type: `a.${status}` })
          .returning(),
      );
      await db
        .insert(backgroundJobAttempts)
        .values({ jobId: j.id, workspaceId: wsA, attemptNumber: 1, status });
    }
  });

  it("rejects orphan jobs and attempts", async () => {
    const db = drizzlePglite(pg, { schema });
    const ghost = uuidv7();
    await expectDbError(
      db.insert(backgroundJobs).values({ workspaceId: ghost, type: "orphan" }),
      /violates foreign key constraint "background_jobs_workspace_id_fkey"/,
    );
    await expectDbError(
      db
        .insert(backgroundJobAttempts)
        .values({ jobId: uuidv7(), workspaceId: wsA, attemptNumber: 1 }),
      /violates foreign key constraint "background_job_attempts_job_id_fkey"/,
    );
    const job = one(
      await db.insert(backgroundJobs).values({ workspaceId: wsA, type: "wsmatch" }).returning(),
    );
    // Same-workspace attempt linkage inserts cleanly (attemptâ†”job same-tenant
    // binding is written by the executor from a single workspace context in
    // Issue 2.6; RLS below proves it can never be read cross-workspace).
    await db
      .insert(backgroundJobAttempts)
      .values({ jobId: job.id, workspaceId: wsA, attemptNumber: 1 });
  });

  it("rejects an attempt whose job belongs to a different workspace", async () => {
    const db = drizzlePglite(pg, { schema });
    const job = one(
      await db
        .insert(backgroundJobs)
        .values({ workspaceId: wsA, type: "tenant-bound" })
        .returning(),
    );

    await expectDbError(
      db
        .insert(backgroundJobAttempts)
        .values({ jobId: job.id, workspaceId: wsB, attemptNumber: 1 }),
      /violates foreign key constraint/,
    );
  });

  it("cascades job deletion to attempts and workspace deletion to everything", async () => {
    const db = drizzlePglite(pg, { schema });
    const job = one(
      await db.insert(backgroundJobs).values({ workspaceId: wsA, type: "ephemeral" }).returning(),
    );
    await db
      .insert(backgroundJobAttempts)
      .values({ jobId: job.id, workspaceId: wsA, attemptNumber: 1 });
    await q(`DELETE FROM background_jobs WHERE id = $1`, [job.id]);
    expect(await count(`background_job_attempts`, `WHERE job_id = $1`, [job.id])).toBe("0");

    const ws = one(await db.insert(workspaces).values({ name: "Ephemeral jobs" }).returning());
    const job2 = one(
      await db.insert(backgroundJobs).values({ workspaceId: ws.id, type: "ephemeral" }).returning(),
    );
    await db
      .insert(backgroundJobAttempts)
      .values({ jobId: job2.id, workspaceId: ws.id, attemptNumber: 1 });
    await q(`DELETE FROM workspaces WHERE id = $1`, [ws.id]);
    expect(await count(`background_jobs`, `WHERE workspace_id = $1`, [ws.id])).toBe("0");
    expect(await count(`background_job_attempts`, `WHERE workspace_id = $1`, [ws.id])).toBe("0");
  });

  it("makes enqueue idempotent per (workspace, type, dedupe_key); NULL keys exempt", async () => {
    const db = drizzlePglite(pg, { schema });
    const key = `upload-${uuidv7()}`;
    await db
      .insert(backgroundJobs)
      .values({ workspaceId: wsA, type: "import.process", dedupeKey: key });
    // Retried HTTP submission with the same key: exactly one job.
    await expectDbError(
      db
        .insert(backgroundJobs)
        .values({ workspaceId: wsA, type: "import.process", dedupeKey: key }),
      /duplicate key value violates unique constraint "background_jobs_workspace_type_dedupe_uniq"/,
    );
    // Same key, different type: independent work.
    await db
      .insert(backgroundJobs)
      .values({ workspaceId: wsA, type: "report.build", dedupeKey: key });
    // Same key+type, other workspace: independent tenant.
    await db
      .insert(backgroundJobs)
      .values({ workspaceId: wsB, type: "import.process", dedupeKey: key });
    // No key: fire-and-forget rows never collide with each other.
    await db.insert(backgroundJobs).values({ workspaceId: wsA, type: "import.process" });
    await db.insert(backgroundJobs).values({ workspaceId: wsA, type: "import.process" });
    expect(
      await count(`background_jobs`, `WHERE type = 'import.process' AND workspace_id = $1`, [wsA]),
    ).toBe("3");
  });

  it("numbers attempts uniquely per job", async () => {
    const db = drizzlePglite(pg, { schema });
    const job = one(
      await db.insert(backgroundJobs).values({ workspaceId: wsA, type: "numbered" }).returning(),
    );
    await db
      .insert(backgroundJobAttempts)
      .values({ jobId: job.id, workspaceId: wsA, attemptNumber: 1 });
    await expectDbError(
      db
        .insert(backgroundJobAttempts)
        .values({ jobId: job.id, workspaceId: wsA, attemptNumber: 1 }),
      /duplicate key value violates unique constraint "background_job_attempts_job_number_uniq"/,
    );
    await db
      .insert(backgroundJobAttempts)
      .values({ jobId: job.id, workspaceId: wsA, attemptNumber: 2 });
  });

  it("exposes the pickup index the worker claims through", async () => {
    const indexes = await q<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'background_jobs'`,
    );
    expect(indexes.map((r) => r.indexname)).toContain("background_jobs_pickup_idx");
  });

  it("keeps scheduled_tasks global: seeded by ops, readable by the app role", async () => {
    const db = drizzlePglite(pg, { schema });
    await db.insert(scheduledTasks).values({ name: "outbox.dispatch", schedule: "*/1 * * * *" });
    await expectDbError(
      db.insert(scheduledTasks).values({ name: "outbox.dispatch", schedule: "*/5 * * * *" }),
      /duplicate key value violates unique constraint|already exists/i,
    );
    const stored = one(
      await db
        .insert(scheduledTasks)
        .values({ name: "jobs.sweep", schedule: "*/5 * * * *" })
        .returning(),
    );
    expect(stored.enabled).toBe(1);
    expect(stored.payload).toEqual({});
    // App role can read schedules (it needs them to tick) but not rewrite them.
    await asApp(wsA, async () => {
      expect(await count("scheduled_tasks")).toBe("2");
      await expectDbError(
        q(`UPDATE scheduled_tasks SET enabled = 0 WHERE name = 'jobs.sweep'`),
        /permission denied for table scheduled_tasks/,
      );
    });
    expect(
      one(
        await q<{ enabled: number }>(
          `SELECT enabled FROM scheduled_tasks WHERE name = 'jobs.sweep'`,
        ),
      ).enabled,
    ).toBe(1);
  });

  it("RLS: A cannot read or touch B's jobs and attempts", async () => {
    const db = drizzlePglite(pg, { schema });
    const secret = `secret-${uuidv7()}`;
    const jobB = one(
      await db
        .insert(backgroundJobs)
        .values({ workspaceId: wsB, type: "secret.job", dedupeKey: secret })
        .returning(),
    );
    await db
      .insert(backgroundJobAttempts)
      .values({ jobId: jobB.id, workspaceId: wsB, attemptNumber: 1 });
    await asApp(wsA, async () => {
      expect(await count("background_jobs", "WHERE dedupe_key = $1", [secret])).toBe("0");
      expect(await count("background_job_attempts", "WHERE job_id = $1", [jobB.id])).toBe("0");
      const renamed = await qRaw("UPDATE background_jobs SET status = 'cancelled' WHERE id = $1", [
        jobB.id,
      ]);
      expect(renamed.affectedRows ?? renamed.rowCount).toBe(0);
      // Forging an attempt bound to B's workspace from A's context is denied.
      await expectDbError(
        q(
          `INSERT INTO background_job_attempts (job_id, workspace_id, attempt_number)
            VALUES ($1, $2, 2)`,
          [jobB.id, wsB],
        ),
        /new row violates row-level security policy for table "background_job_attempts"/,
      );
    });
    await asApp(wsB, async () => {
      expect(await count("background_jobs", "WHERE dedupe_key = $1", [secret])).toBe("1");
      expect(await count("background_job_attempts", "WHERE job_id = $1", [jobB.id])).toBe("1");
    });
  });

  it("RLS: missing tenant context sees no jobs", async () => {
    await asApp(null, async () => {
      expect(await count("background_jobs")).toBe("0");
      expect(await count("background_job_attempts")).toBe("0");
    });
  });

  it("grants the app role job read/write and schedule read", async () => {
    const grants = await q<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'moneo_app'
         AND table_name IN ('background_jobs', 'background_job_attempts', 'scheduled_tasks')
       ORDER BY table_name, privilege_type`,
    );
    const byTable = new Map<string, string[]>();
    for (const g of grants) {
      byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.privilege_type]);
    }
    expect(byTable.get("background_jobs")).toEqual(
      expect.arrayContaining(["SELECT", "INSERT", "UPDATE"]),
    );
    expect(byTable.get("background_job_attempts")).toEqual(
      expect.arrayContaining(["SELECT", "INSERT", "UPDATE"]),
    );
    expect(byTable.get("scheduled_tasks")).toEqual(["SELECT"]);
  });
});
