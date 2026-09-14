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
  tags,
  transactions,
  transactionTags,
  workspaces,
} from "./schema.js";
import {
  executeAddTags,
  executeExcludeFromAnalytics,
  executeRemoveTags,
  executeSetCategory,
  executeSetCounterparty,
  executeSetNote,
} from "./correction-commands.js";
import { createMigratedDb, one } from "./pglite-test-db.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 5.3 â€” correction commands over Drizzle (migrations 0014â€“0015).
 *
 * Proves end to end: each command bumps the version exactly once, persists
 * the correction, and lands audit + outbox rows with the effect; retries
 * converge on the stored result; foreign ids fail closed; and the Epoch 5
 * two-tab acceptance holds through the real executors (stale
 * expectedVersion â†’ VERSION_CONFLICT, no silent overwrite).
 */
describe("transaction correction commands (issue 5.3)", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Corrections A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Corrections B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  const ctxFor = (workspaceId: string, key: string, expectedVersion?: number) => ({
    workspaceId,
    actorUserId: null as string | null,
    idempotencyKey: key,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });

  async function seedTransaction(ws: string, description?: string) {
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
          amountMinor: 3142,
          currencyCode: "EUR",
          effectiveDate: "2026-09-10",
          description: description ?? `LIDL SAGT DANKE ${uuidv7()}`,
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

  it("sets category, counterparty, note, and exclusion with audit + outbox", async () => {
    const db = drizzlePglite(pg, { schema });
    const txn = await seedTransaction(wsA);
    const category = one(
      await db
        .insert(categories)
        .values({ workspaceId: wsA, name: `Groceries ${uuidv7()}` })
        .returning(),
    );

    const cat = await executeSetCategory(db, ctxFor(wsA, `cat-${uuidv7()}`, 1), {
      transactionId: txn.id,
      categoryId: category.id,
    });
    expect(cat.result).toMatchObject({ transactionId: txn.id, version: 2 });

    const cp = await executeSetCounterparty(db, ctxFor(wsA, `cp-${uuidv7()}`, 2), {
      transactionId: txn.id,
      counterpartyName: "Lidl",
    });
    expect(cp.result.version).toBe(3);
    expect(typeof cp.result.counterpartyId).toBe("string");

    const note = await executeSetNote(db, ctxFor(wsA, `note-${uuidv7()}`, 3), {
      transactionId: txn.id,
      note: "Weekly shop",
    });
    expect(note.result).toMatchObject({ version: 4, note: "Weekly shop" });

    const excl = await executeExcludeFromAnalytics(db, ctxFor(wsA, `excl-${uuidv7()}`, 4), {
      transactionId: txn.id,
      excluded: true,
    });
    expect(excl.result).toMatchObject({ version: 5, excluded: true });

    const current = await readTransaction(wsA, txn.id);
    expect(current).toMatchObject({
      categoryId: category.id,
      counterpartyId: cp.result.counterpartyId,
      note: "Weekly shop",
      excludedFromAnalytics: true,
      version: 5,
    });

    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, wsA), eq(auditEvents.entityId, txn.id)));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "transactions.excludeFromAnalytics",
      "transactions.setCategory",
      "transactions.setCounterparty",
      "transactions.setNote",
    ]);
    for (const audit of audits) {
      expect(typeof audit.commandOperationId).toBe("string");
      const oldValue = audit.oldValue as { version: unknown };
      const newValue = audit.newValue as { version: unknown };
      expect(typeof oldValue.version).toBe("number");
      expect(newValue.version).toBe((oldValue.version as number) + 1);
    }
    const outbox = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, wsA), eq(outboxEvents.aggregateId, txn.id)));
    expect(outbox.map((e) => e.eventType).sort()).toEqual([
      "transaction.category_changed",
      "transaction.counterparty_changed",
      "transaction.exclusion_changed",
      "transaction.note_changed",
    ]);
  });

  it("adds and removes tags end to end", async () => {
    const db = drizzlePglite(pg, { schema });
    const txn = await seedTransaction(wsA);
    const added = await executeAddTags(db, ctxFor(wsA, `add-${uuidv7()}`, 1), {
      transactionId: txn.id,
      tags: ["Food", "germany"],
    });
    expect(added.result).toMatchObject({ version: 2, tags: ["Food", "germany"] });
    expect(
      await db.select().from(transactionTags).where(eq(transactionTags.transactionId, txn.id)),
    ).toHaveLength(2);

    const removed = await executeRemoveTags(db, ctxFor(wsA, `rm-${uuidv7()}`, 2), {
      transactionId: txn.id,
      tags: ["Food"],
    });
    expect(removed.result).toMatchObject({ version: 3, tags: ["germany"] });
    // Tag rows survive (shared vocabulary); only the link is removed.
    expect(await db.select().from(tags)).not.toHaveLength(0);
  });

  it("converges idempotent retries onto one effect", async () => {
    const db = drizzlePglite(pg, { schema });
    const txn = await seedTransaction(wsA);
    const key = `retry-${uuidv7()}`;
    const first = await executeSetNote(db, ctxFor(wsA, key, 1), {
      transactionId: txn.id,
      note: "once",
    });
    const replay = await executeSetNote(db, ctxFor(wsA, key, 1), {
      transactionId: txn.id,
      note: "once",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect((await readTransaction(wsA, txn.id)).version).toBe(2);
  });

  it("fails closed for foreign transactions and categories", async () => {
    const db = drizzlePglite(pg, { schema });
    const txnB = await seedTransaction(wsB);
    const catB = one(
      await db
        .insert(categories)
        .values({ workspaceId: wsB, name: `Foreign ${uuidv7()}` })
        .returning(),
    );
    const txnA = await seedTransaction(wsA);

    await expect(
      executeSetNote(db, ctxFor(wsA, `x-${uuidv7()}`), { transactionId: txnB.id, note: "hijack" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      executeSetCategory(db, ctxFor(wsA, `x-${uuidv7()}`), {
        transactionId: txnA.id,
        categoryId: catB.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      executeAddTags(db, ctxFor(wsA, `x-${uuidv7()}`), { transactionId: txnB.id, tags: ["evil"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Nothing moved.
    expect((await readTransaction(wsB, txnB.id)).version).toBe(1);
    expect((await readTransaction(wsA, txnA.id)).categoryId).toBeNull();
  });

  it("enforces the two-tab acceptance through the real executors", async () => {
    const db = drizzlePglite(pg, { schema });
    const txn = await seedTransaction(wsA);
    const catA = one(
      await db
        .insert(categories)
        .values({ workspaceId: wsA, name: `Tab A ${uuidv7()}` })
        .returning(),
    );
    const catB = one(
      await db
        .insert(categories)
        .values({ workspaceId: wsA, name: `Tab B ${uuidv7()}` })
        .returning(),
    );
    // Both tabs read version 1. Tab A wins.
    await executeSetCategory(db, ctxFor(wsA, `taba-${uuidv7()}`, 1), {
      transactionId: txn.id,
      categoryId: catA.id,
    });
    // Tab B submits its stale version: conflict, no silent overwrite.
    await expect(
      executeSetCategory(db, ctxFor(wsA, `tabb-${uuidv7()}`, 1), {
        transactionId: txn.id,
        categoryId: catB.id,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const current = await readTransaction(wsA, txn.id);
    expect(current.categoryId).toBe(catA.id);
    expect(current.version).toBe(2);
  });
});
