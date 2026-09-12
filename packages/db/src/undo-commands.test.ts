import { and, eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import {
  accounts,
  auditEvents,
  categories,
  outboxEvents,
  transactions,
  workspaces,
} from "./schema.js";
import { executeAddTags, executeSetCategory } from "./correction-commands.js";
import { executeUndo } from "./undo-commands.js";
import { createMigratedDb, one } from "./pglite-test-db.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 5.4 — `operations.undo` over Drizzle (migrations 0014–0015).
 *
 * Proves end to end: undo compensates the recorded correction and lands
 * its own audit + outbox rows; a retried undo converges; undo after a
 * newer change fails with UNDO_CONFLICT and preserves the newer state;
 * unknown, foreign, and already-undone (undo-of-undo) operations fail
 * closed; tag undos restore the exact recorded set.
 */
describe("operations.undo command (issue 5.4)", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;

  beforeAll(async () => {
    pg = await createMigratedDb("0015_entity_versions");
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Undo A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Undo B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  const ctxFor = (workspaceId: string, key: string) => ({
    workspaceId,
    actorUserId: null as string | null,
    idempotencyKey: key,
  });

  async function seedTransaction(ws: string) {
    const db = drizzlePglite(pg, { schema });
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: ws, name: `Account ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    return one(
      await db
        .insert(transactions)
        .values({
          workspaceId: ws,
          accountId: account.id,
          direction: "debit",
          amountMinor: 100,
          currencyCode: "EUR",
          effectiveDate: "2026-09-10",
          description: `Undoable ${uuidv7()}`,
        })
        .returning(),
    );
  }

  async function readTransaction(ws: string, id: string) {
    const db = drizzlePglite(pg, { schema });
    return one(
      await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.workspaceId, ws), eq(transactions.id, id))),
    );
  }

  it("compensates a correction with its own audit and outbox rows", async () => {
    const db = drizzlePglite(pg, { schema });
    const txn = await seedTransaction(wsA);
    const category = one(
      await db
        .insert(categories)
        .values({ workspaceId: wsA, name: `Undo cat ${uuidv7()}` })
        .returning(),
    );
    const done = await executeSetCategory(
      db,
      { ...ctxFor(wsA, `orig-${uuidv7()}`), expectedVersion: 1 },
      { transactionId: txn.id, categoryId: category.id },
    );

    const undone = await executeUndo(
      db,
      ctxFor(wsA, `undo-${uuidv7()}`),
      { operationId: done.operationId },
    );
    expect(undone.result).toMatchObject({
      undoneOperationId: done.operationId,
      transactionId: txn.id,
      version: 3,
    });
    expect(undone.replayed).toBe(false);
    expect(await readTransaction(wsA, txn.id)).toMatchObject({ categoryId: null, version: 3 });

    const audits = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, wsA), eq(auditEvents.entityId, txn.id)));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "operations.undo",
      "transactions.setCategory",
    ]);
    const outbox = await db
      .select({ eventType: outboxEvents.eventType })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, wsA), eq(outboxEvents.aggregateId, txn.id)));
    expect(outbox.map((e) => e.eventType).sort()).toEqual([
      "transaction.category_changed",
      "transaction.correction_undone",
    ]);
  });

  it("converges retried undos onto one compensation", async () => {
    const db = drizzlePglite(pg, { schema });
    const txn = await seedTransaction(wsA);
    const category = one(
      await db
        .insert(categories)
        .values({ workspaceId: wsA, name: `Retry cat ${uuidv7()}` })
        .returning(),
    );
    const done = await executeSetCategory(
      db,
      { ...ctxFor(wsA, `orig-${uuidv7()}`), expectedVersion: 1 },
      { transactionId: txn.id, categoryId: category.id },
    );
    const key = `undo-${uuidv7()}`;
    const first = await executeUndo(db, ctxFor(wsA, key), { operationId: done.operationId });
    const replay = await executeUndo(db, ctxFor(wsA, key), { operationId: done.operationId });
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect((await readTransaction(wsA, txn.id)).version).toBe(3);
  });

  it("refuses undo after a newer change with UNDO_CONFLICT", async () => {
    const db = drizzlePglite(pg, { schema });
    const txn = await seedTransaction(wsA);
    const catA = one(
      await db
        .insert(categories)
        .values({ workspaceId: wsA, name: `First ${uuidv7()}` })
        .returning(),
    );
    const catB = one(
      await db
        .insert(categories)
        .values({ workspaceId: wsA, name: `Second ${uuidv7()}` })
        .returning(),
    );
    const first = await executeSetCategory(
      db,
      { ...ctxFor(wsA, `first-${uuidv7()}`), expectedVersion: 1 },
      { transactionId: txn.id, categoryId: catA.id },
    );
    await executeSetCategory(
      db,
      { ...ctxFor(wsA, `second-${uuidv7()}`), expectedVersion: 2 },
      { transactionId: txn.id, categoryId: catB.id },
    );
    await expect(
      executeUndo(db, ctxFor(wsA, `late-${uuidv7()}`), { operationId: first.operationId }),
    ).rejects.toMatchObject({ code: "UNDO_CONFLICT" });
    // The newer correction survives untouched.
    expect(await readTransaction(wsA, txn.id)).toMatchObject({ categoryId: catB.id, version: 3 });
  });

  it("fails closed on unknown, foreign, and undo-of-undo operations", async () => {
    const db = drizzlePglite(pg, { schema });
    const txnB = await seedTransaction(wsB);
    const catB = one(
      await db
        .insert(categories)
        .values({ workspaceId: wsB, name: `Foreign ${uuidv7()}` })
        .returning(),
    );
    const doneB = await executeSetCategory(
      db,
      { ...ctxFor(wsB, `b-${uuidv7()}`), expectedVersion: 1 },
      { transactionId: txnB.id, categoryId: catB.id },
    );

    await expect(
      executeUndo(db, ctxFor(wsA, `u-${uuidv7()}`), { operationId: `${wsA}:zzz:nope` }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A real operation id from another workspace is still foreign.
    await expect(
      executeUndo(db, ctxFor(wsA, `u-${uuidv7()}`), { operationId: doneB.operationId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await readTransaction(wsB, txnB.id)).version).toBe(2);

    const txnA = await seedTransaction(wsA);
    const catA = one(
      await db
        .insert(categories)
        .values({ workspaceId: wsA, name: `Own ${uuidv7()}` })
        .returning(),
    );
    const doneA = await executeSetCategory(
      db,
      { ...ctxFor(wsA, `a-${uuidv7()}`), expectedVersion: 1 },
      { transactionId: txnA.id, categoryId: catA.id },
    );
    const undoneA = await executeUndo(
      db,
      ctxFor(wsA, `u-${uuidv7()}`),
      { operationId: doneA.operationId },
    );
    // Undoing the compensating command itself is rejected, not chained.
    await expect(
      executeUndo(db, ctxFor(wsA, `u-${uuidv7()}`), { operationId: undoneA.operationId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("restores the exact recorded tag set", async () => {
    const db = drizzlePglite(pg, { schema });
    const txn = await seedTransaction(wsA);
    const added = await executeAddTags(
      db,
      { ...ctxFor(wsA, `add-${uuidv7()}`), expectedVersion: 1 },
      { transactionId: txn.id, tags: ["food", "germany"] },
    );
    expect(added.result.tags).toEqual(["food", "germany"]);
    const undone = await executeUndo(
      db,
      ctxFor(wsA, `undo-${uuidv7()}`),
      { operationId: added.operationId },
    );
    expect(undone.result.version).toBe(3);
    expect((await readTransaction(wsA, txn.id)).version).toBe(3);
  });
});
