import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { auditEvents, commandOperations, outboxEvents, users, workspaces } from "./schema.js";
import { createMigratedDb, expectDbError, one, tableNames } from "./pglite-test-db.js";
import { isUuidV7, uuidv7 } from "./uuid.js";
import { TENANT_SETTING } from "./tenancy.js";

/**
 * Issue 2.1 â€” Command/Audit/Outbox schema.
 *
 * Applies the REAL shipped chain (0000â€“0005) to PGlite and proves, in order:
 *   1. the three tables exist with the expected columns/defaults;
 *   2. (workspace_id, command_name, idempotency_key) is truly unique, scoped
 *      per command AND per workspace (the idempotency claim of Issue 2.2);
 *   3. status allowlists reject garbage on both tables;
 *   4. workspace FKs reject orphans and cascade on workspace deletion;
 *   5. audit rows link back to their command operation (nullable);
 *   6. the dispatcher index exists for the Issue 2.5 claim query;
 *   7. RLS: A cannot read B, missing context sees nothing, cross-workspace
 *      writes fail, audit history is append-only for the app role.
 */
describe("command/audit/outbox schema (migration 0005)", () => {
  let pg!: PGlite;

  let userA!: string;
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

  /** Run `fn` as the runtime role with an optional tenant context. */
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
    userA = one(await db.insert(users).values({ authSubject: "auth0|cmd-a" }).returning()).id;
    await db.insert(users).values({ authSubject: "auth0|cmd-b" });
    wsA = one(await db.insert(workspaces).values({ name: "Cmd A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Cmd B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates the three tables with UUIDv7 defaults", async () => {
    const tables = await tableNames(pg);
    expect(tables).toContain("command_operations");
    expect(tables).toContain("audit_events");
    expect(tables).toContain("outbox_events");

    const cols = async (table: string) =>
      (
        await q<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
          [table],
        )
      ).map((r) => r.column_name);
    // input_hash arrives via a later ALTER (Issue 4.10), so it sorts last.
    expect(await cols("command_operations")).toEqual([
      "id",
      "workspace_id",
      "command_name",
      "idempotency_key",
      "actor_user_id",
      "expected_version",
      "resulting_version",
      "status",
      "result",
      "created_at",
      "updated_at",
      "input_hash",
    ]);
    expect(await cols("audit_events")).toEqual([
      "id",
      "workspace_id",
      "command_operation_id",
      "actor_user_id",
      "entity_type",
      "entity_id",
      "action",
      "old_value",
      "new_value",
      "created_at",
      "reason",
      "related_ai_run_id",
    ]);
    expect(await cols("outbox_events")).toEqual([
      "id",
      "workspace_id",
      "aggregate_type",
      "aggregate_id",
      "event_type",
      "payload",
      "status",
      "attempts",
      "next_attempt_at",
      "published_at",
      "created_at",
      "claimed_at",
      "last_error",
    ]);

    // Server-side DEFAULT safety net mirrors the app uuidv7().
    const db = drizzlePglite(pg, { schema });
    const cmd = one(
      await db
        .insert(commandOperations)
        .values({ workspaceId: wsA, commandName: "probe", idempotencyKey: `k-${uuidv7()}` })
        .returning(),
    );
    expect(isUuidV7(cmd.id)).toBe(true);
    expect(cmd.status).toBe("succeeded");
    expect(cmd.result).toEqual({});
    const audit = one(
      await db
        .insert(auditEvents)
        .values({ workspaceId: wsA, entityType: "t", entityId: "e", action: "a" })
        .returning(),
    );
    expect(isUuidV7(audit.id)).toBe(true);
    const outbox = one(
      await db
        .insert(outboxEvents)
        .values({ workspaceId: wsA, aggregateType: "t", aggregateId: "e", eventType: "t.e" })
        .returning(),
    );
    expect(isUuidV7(outbox.id)).toBe(true);
    expect(outbox.status).toBe("pending");
    expect(outbox.attempts).toBe(0);
    expect(outbox.payload).toEqual({});
    expect(outbox.publishedAt).toBeNull();
  });

  it("enforces (workspace_id, command_name, idempotency_key) uniqueness: replay conflicts", async () => {
    const db = drizzlePglite(pg, { schema });
    const key = `replay-${uuidv7()}`;
    await db
      .insert(commandOperations)
      .values({ workspaceId: wsA, commandName: "transactions.setCategory", idempotencyKey: key });
    await expectDbError(
      db
        .insert(commandOperations)
        .values({ workspaceId: wsA, commandName: "transactions.setCategory", idempotencyKey: key }),
      /duplicate key value violates unique constraint "command_operations_workspace_command_key_uniq"/,
    );
  });

  it("scopes the idempotency key per command name", async () => {
    const db = drizzlePglite(pg, { schema });
    const key = `shared-${uuidv7()}`;
    await db
      .insert(commandOperations)
      .values({ workspaceId: wsA, commandName: "cmd.one", idempotencyKey: key });
    // Same key under a different command name is a different claim.
    const row = one(
      await db
        .insert(commandOperations)
        .values({ workspaceId: wsA, commandName: "cmd.two", idempotencyKey: key })
        .returning({ id: commandOperations.id }),
    );
    expect(isUuidV7(row.id)).toBe(true);
  });

  it("scopes the idempotency key per workspace: A and B can reuse the same key", async () => {
    const db = drizzlePglite(pg, { schema });
    const key = `shared-ws-${uuidv7()}`;
    await db
      .insert(commandOperations)
      .values({ workspaceId: wsA, commandName: "cmd.x", idempotencyKey: key });
    const row = one(
      await db
        .insert(commandOperations)
        .values({ workspaceId: wsB, commandName: "cmd.x", idempotencyKey: key })
        .returning({ id: commandOperations.id }),
    );
    expect(isUuidV7(row.id)).toBe(true);
  });

  it("rejects unknown command/outbox statuses via CHECK constraints", async () => {
    const db = drizzlePglite(pg, { schema });
    await expectDbError(
      db.insert(commandOperations).values({
        workspaceId: wsA,
        commandName: "bad",
        idempotencyKey: `k-${uuidv7()}`,
        status: "exploded",
      }),
      /violates check constraint "command_operations_status_check"/,
    );
    await expectDbError(
      db.insert(outboxEvents).values({
        workspaceId: wsA,
        aggregateType: "t",
        aggregateId: "e",
        eventType: "t.e",
        status: "teleported",
      }),
      /violates check constraint "outbox_events_status_check"/,
    );
    // Every documented lifecycle state is accepted.
    for (const status of ["claimed", "succeeded", "failed"] as const) {
      await db.insert(commandOperations).values({
        workspaceId: wsA,
        commandName: `cmd.${status}`,
        idempotencyKey: `k-${uuidv7()}`,
        status,
      });
    }
    for (const status of ["claimed", "published", "failed"] as const) {
      await db.insert(outboxEvents).values({
        workspaceId: wsA,
        aggregateType: "t",
        aggregateId: "e",
        eventType: `t.${status}`,
        status,
      });
    }
  });

  it("rejects orphan rows bound to unknown workspaces", async () => {
    const db = drizzlePglite(pg, { schema });
    const ghost = uuidv7();
    await expectDbError(
      db
        .insert(commandOperations)
        .values({ workspaceId: ghost, commandName: "orphan", idempotencyKey: `k-${uuidv7()}` }),
      /violates foreign key constraint "command_operations_workspace_id_fkey"/,
    );
    await expectDbError(
      db
        .insert(auditEvents)
        .values({ workspaceId: ghost, entityType: "t", entityId: "e", action: "a" }),
      /violates foreign key constraint "audit_events_workspace_id_fkey"/,
    );
    await expectDbError(
      db.insert(outboxEvents).values({
        workspaceId: ghost,
        aggregateType: "t",
        aggregateId: "e",
        eventType: "t.e",
      }),
      /violates foreign key constraint "outbox_events_workspace_id_fkey"/,
    );
  });

  it("cascades workspace deletion across all three tables", async () => {
    const db = drizzlePglite(pg, { schema });
    const ws = one(await db.insert(workspaces).values({ name: "Ephemeral 2" }).returning());
    const cmd = one(
      await db
        .insert(commandOperations)
        .values({ workspaceId: ws.id, commandName: "ephemeral.cmd", idempotencyKey: "k" })
        .returning(),
    );
    await db.insert(auditEvents).values({
      workspaceId: ws.id,
      commandOperationId: cmd.id,
      entityType: "t",
      entityId: "e",
      action: "ephemeral.cmd",
    });
    await db.insert(outboxEvents).values({
      workspaceId: ws.id,
      aggregateType: "t",
      aggregateId: "e",
      eventType: "t.e",
    });
    await q(`DELETE FROM workspaces WHERE id = $1`, [ws.id]);
    expect(await count(`command_operations`, `WHERE workspace_id = $1`, [ws.id])).toBe("0");
    expect(await count(`audit_events`, `WHERE workspace_id = $1`, [ws.id])).toBe("0");
    expect(await count(`outbox_events`, `WHERE workspace_id = $1`, [ws.id])).toBe("0");
  });

  it("audit rows optionally link to their command operation, null when standalone", async () => {
    const db = drizzlePglite(pg, { schema });
    const key = `link-${uuidv7()}`;
    const cmd = one(
      await db
        .insert(commandOperations)
        .values({ workspaceId: wsA, commandName: "link.cmd", idempotencyKey: key })
        .returning(),
    );
    const linked = one(
      await db
        .insert(auditEvents)
        .values({
          workspaceId: wsA,
          commandOperationId: cmd.id,
          actorUserId: userA,
          entityType: "transaction",
          entityId: "txn_1",
          action: "link.cmd",
          oldValue: { category: "old" },
          newValue: { category: "new" },
        })
        .returning(),
    );
    expect(linked.commandOperationId).toBe(cmd.id);
    expect(linked.oldValue).toEqual({ category: "old" });
    const standalone = one(
      await db
        .insert(auditEvents)
        .values({ workspaceId: wsA, entityType: "transaction", entityId: "txn_2", action: "note" })
        .returning(),
    );
    expect(standalone.commandOperationId).toBeNull();
    // Dangling command link is rejected.
    await expectDbError(
      db.insert(auditEvents).values({
        workspaceId: wsA,
        commandOperationId: uuidv7(),
        entityType: "t",
        entityId: "e",
        action: "a",
      }),
      /violates foreign key constraint "audit_events_command_operation_id_fkey"/,
    );
  });

  it("exposes the dispatcher claim index", async () => {
    const indexes = await q<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'outbox_events'`,
    );
    expect(indexes.map((r) => r.indexname)).toContain("outbox_events_dispatch_idx");
  });

  it("RLS: A cannot read B across all three tables", async () => {
    const db = drizzlePglite(pg, { schema });
    const keyB = `secret-${uuidv7()}`;
    await db
      .insert(commandOperations)
      .values({ workspaceId: wsB, commandName: "secret.cmd", idempotencyKey: keyB });
    await db.insert(auditEvents).values({
      workspaceId: wsB,
      entityType: "transaction",
      entityId: "hidden",
      action: "secret.cmd",
    });
    await db.insert(outboxEvents).values({
      workspaceId: wsB,
      aggregateType: "transaction",
      aggregateId: "hidden",
      eventType: "transaction.hidden",
    });
    await asApp(wsA, async () => {
      // B-only markers are invisible from A, even though A legitimately sees
      // its own rows created by earlier tests in this file.
      expect(await count("command_operations", "WHERE idempotency_key = $1", [keyB])).toBe("0");
      expect(await count("audit_events", "WHERE entity_id = 'hidden'")).toBe("0");
      expect(await count("outbox_events", "WHERE aggregate_id = 'hidden'")).toBe("0");
      expect(Number(await count("command_operations"))).toBeGreaterThan(0);
    });
    await asApp(wsB, async () => {
      expect(await count("command_operations", "WHERE idempotency_key = $1", [keyB])).toBe("1");
      expect(await count("audit_events", "WHERE entity_id = 'hidden'")).toBe("1");
      expect(await count("outbox_events", "WHERE aggregate_id = 'hidden'")).toBe("1");
    });
  });

  it("RLS: missing tenant context sees nothing", async () => {
    await asApp(null, async () => {
      expect(await count("command_operations")).toBe("0");
      expect(await count("audit_events")).toBe("0");
      expect(await count("outbox_events")).toBe("0");
    });
  });

  it("RLS: cross-workspace writes are rejected", async () => {
    await asApp(wsA, async () => {
      await expectDbError(
        q(
          `INSERT INTO outbox_events (workspace_id, aggregate_type, aggregate_id, event_type)
            VALUES ($1, 't', 'e', 't.e')`,
          [wsB],
        ),
        /new row violates row-level security policy for table "outbox_events"/,
      );
      await expectDbError(
        q(
          `INSERT INTO command_operations (workspace_id, command_name, idempotency_key)
            VALUES ($1, 'forged.cmd', $2)`,
          [wsB, `k-${uuidv7()}`],
        ),
        /new row violates row-level security policy for table "command_operations"/,
      );
    });
  });

  it("RLS: audit history is append-only for the app role (UPDATE/DELETE match zero rows)", async () => {
    const db = drizzlePglite(pg, { schema });
    const row = one(
      await db
        .insert(auditEvents)
        .values({
          workspaceId: wsA,
          entityType: "t",
          entityId: `immutable-${uuidv7()}`,
          action: "a",
        })
        .returning(),
    );
    await asApp(wsA, async () => {
      // No UPDATE/DELETE policy on audit_events: statements succeed but match
      // zero rows â€” deny by default, history can never be rewritten.
      const rewritten = await qRaw(`UPDATE audit_events SET action = 'rewritten' WHERE id = $1`, [
        row.id,
      ]);
      expect(rewritten.affectedRows ?? rewritten.rowCount).toBe(0);
      const deleted = await qRaw(`DELETE FROM audit_events WHERE id = $1`, [row.id]);
      expect(deleted.affectedRows ?? deleted.rowCount).toBe(0);
    });
    // Owner view: history is byte-for-byte intact.
    expect(
      one(await q<{ action: string }>(`SELECT action FROM audit_events WHERE id = $1`, [row.id]))
        .action,
    ).toBe("a");
    // Owner deletes the probe rows it created (cross-test hygiene).
    await qRaw(`DELETE FROM audit_events WHERE entity_type = 't' AND workspace_id = $1`, [wsA]);
  });

  it("grants the app role read/write on commands and outbox, append/read on audit", async () => {
    const grants = await q<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'moneo_app'
         AND table_name IN ('command_operations', 'audit_events', 'outbox_events')
       ORDER BY table_name, privilege_type`,
    );
    const byTable = new Map<string, string[]>();
    for (const g of grants) {
      byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.privilege_type]);
    }
    expect(byTable.get("command_operations")).toEqual(
      expect.arrayContaining(["SELECT", "INSERT", "UPDATE"]),
    );
    expect(byTable.get("outbox_events")).toEqual(
      expect.arrayContaining(["SELECT", "INSERT", "UPDATE"]),
    );
    expect(byTable.get("audit_events")).toEqual(expect.arrayContaining(["SELECT", "INSERT"]));
  });
});
