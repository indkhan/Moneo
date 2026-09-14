import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@moneo/db/client";
import { insertBackgroundJob } from "@moneo/db/job-queue";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { loadEnv } from "@moneo/shared/env";
import { createMemoryObjectStore } from "@moneo/shared/uploads";
import { createDurableJobExecutor } from "./durable-executor.js";
import { createProductionImportHandler } from "./import-adapter.js";
import { IMPORT_JOB_TYPE } from "./import-workflow.js";
import { dispatchOutboxBatch } from "./outbox.js";
import { createPgOutboxStore } from "./outbox-store.js";

const live = process.env.MONEO_LIVE_SMOKE === "1";

describe.runIf(live)("live durable import smoke", () => {
  const env = loadEnv();
  const admin = new Pool({ connectionString: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL });
  const dispatcher = env.OUTBOX_DATABASE_URL
    ? new Pool({ connectionString: env.OUTBOX_DATABASE_URL })
    : undefined;
  const workspaceId = randomUUID();

  afterAll(async () => {
    await admin.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await admin.end();
    await dispatcher?.end();
    await closeDb();
  });

  it("dispatches import bytes into canonical rows exactly once", async () => {
    if (!dispatcher) throw new Error("OUTBOX_DATABASE_URL is required for live smoke");
    const importId = randomUUID();
    const dataSourceId = randomUUID();
    const objectKey = `quarantine/${workspaceId}/${importId}/statement.csv`;
    const objects = createMemoryObjectStore();
    await objects.put(
      objectKey,
      new TextEncoder().encode(
        "Date,Description,Amount,Currency\n2026-09-01,Coffee,-250,EUR\n2026-09-02,Salary,100000,EUR\n",
      ),
    );
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [
      workspaceId,
      "Import smoke",
    ]);

    const submitted = await withWorkspaceTransaction(workspaceId, (db) =>
      insertBackgroundJob(db, {
        workspaceId,
        type: IMPORT_JOB_TYPE,
        dedupeKey: importId,
        payload: {
          importId,
          dataSourceId,
          objectKey,
          fileName: "statement.csv",
          mapping: {
            date: 0,
            description: 1,
            amount: 2,
            credit: null,
            debit: null,
            currency: 3,
            direction: null,
            account: null,
          },
        },
      }),
    );

    const delivered: { payload: Record<string, unknown>; workspaceId: string }[] = [];
    const dispatcherIdentity = await dispatcher.query(
      "SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(dispatcherIdentity.rows[0]).toEqual({
      current_user: "moneo_dispatcher",
      rolbypassrls: false,
    });
    const outcome = await dispatchOutboxBatch(createPgOutboxStore(dispatcher), {
      publish: (_id, data) => {
        delivered.push(data);
        return Promise.resolve();
      },
    });
    expect(outcome.published).toBe(1);
    expect(delivered[0]?.payload.backgroundJobId).toBe(submitted.job.id);

    const execute = createDurableJobExecutor(
      new Map([[IMPORT_JOB_TYPE, createProductionImportHandler(objects)]]),
    );
    expect(await execute(submitted.job.id, workspaceId, "smoke-worker")).toMatchObject({
      status: "succeeded",
    });
    expect(await execute(submitted.job.id, workspaceId, "smoke-worker")).toMatchObject({
      status: "skipped",
      reason: "terminal",
    });

    const counts = await admin.query(
      `SELECT
      (SELECT count(*)::int FROM imports WHERE workspace_id = $1) AS imports,
      (SELECT count(*)::int FROM source_transaction_observations WHERE workspace_id = $1) AS observations,
      (SELECT count(*)::int FROM transactions WHERE workspace_id = $1) AS transactions,
      (SELECT count(*)::int FROM background_job_attempts WHERE workspace_id = $1) AS attempts`,
      [workspaceId],
    );
    expect(counts.rows[0]).toEqual({ imports: 1, observations: 2, transactions: 2, attempts: 1 });
  });
});
