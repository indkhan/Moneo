import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { accounts, transactions, workspaces } from "./schema.js";
import {
  createFrozenTransactionSelection,
  getFrozenTransactionSelection,
} from "./transaction-workspace.js";
import { executeFrozenBulk } from "./transaction-bulk.js";
import { createSearchCursorCodec, searchTransactions } from "./transaction-queries.js";
import { createMigratedDb, one } from "./pglite-test-db.js";

describe("frozen transaction selections", () => {
  let pg: PGlite;
  let workspaceId: string;
  let accountId: string;

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    workspaceId = one(
      await db.insert(workspaces).values({ name: "Selection workspace" }).returning(),
    ).id;
    accountId = one(
      await db
        .insert(accounts)
        .values({ workspaceId, name: "Cash", currencyCode: "EUR" })
        .returning(),
    ).id;
    for (let i = 0; i < 125; i += 1) {
      await db.insert(transactions).values({
        workspaceId,
        accountId,
        direction: "debit",
        amountMinor: i + 1,
        currencyCode: "EUR",
        effectiveDate: "2026-09-01",
        description: `row ${i}`,
      });
    }
  });

  afterAll(async () => pg.close());

  it("applies frozen corrections once and keeps date/direction selection aligned", async () => {
    const db = drizzlePglite(pg, { schema });
    const selection = await createFrozenTransactionSelection(db, workspaceId, {
      q: "row 12",
      directions: ["debit"],
      dateFrom: "2026-09-01",
      dateTo: "2026-09-01",
    });
    expect(selection.items).toHaveLength(6);
    const input = {
      workspaceId,
      actorUserId: null,
      idempotencyKey: "bulk-once",
      selectionId: selection.id,
      command: "addTags" as const,
      tags: ["Reviewed"],
    };
    expect(await executeFrozenBulk(db, input)).toMatchObject({ applied: 6, conflicts: [] });
    expect(await executeFrozenBulk(db, input)).toMatchObject({
      applied: 0,
      replayed: 6,
      conflicts: [],
    });
    const filtered = await searchTransactions(
      db,
      workspaceId,
      { tagNames: ["Reviewed"] },
      createSearchCursorCodec("test"),
    );
    expect(filtered.items).toHaveLength(6);
    expect(
      (await createFrozenTransactionSelection(db, workspaceId, { tagNames: ["Reviewed"] })).items
        .map((i) => i.id)
        .sort(),
    ).toEqual(filtered.items.map((i) => i.id).sort());
    expect(
      (
        await searchTransactions(
          db,
          workspaceId,
          { categoryIds: ["00000000-0000-4000-8000-000000000099"] },
          createSearchCursorCodec("test"),
        )
      ).items,
    ).toHaveLength(0);
    expect(
      (await createFrozenTransactionSelection(db, workspaceId, { directions: ["credit"] })).items,
    ).toHaveLength(0);
    expect(
      (await createFrozenTransactionSelection(db, workspaceId, { dateTo: "2026-08-31" })).items,
    ).toHaveLength(0);
  });

  it("freezes every matching row and its version before later rows exist", async () => {
    const db = drizzlePglite(pg, { schema });
    const selection = await createFrozenTransactionSelection(db, workspaceId, { q: "row" });
    expect(selection.items).toHaveLength(125);

    await db.insert(transactions).values({
      workspaceId,
      accountId,
      direction: "debit",
      amountMinor: 999,
      currencyCode: "EUR",
      effectiveDate: "2026-09-01",
      description: "row added later",
    });

    const restored = await getFrozenTransactionSelection(db, workspaceId, selection.id);
    expect(restored?.items).toHaveLength(125);
    expect(restored?.items).toEqual(selection.items);
  });

  it("refuses oversized selections instead of silently truncating their targets", async () => {
    await pg.query(
      "INSERT INTO transactions(workspace_id,account_id,direction,amount_minor,currency_code,effective_date,description) SELECT $1,$2,'debit',1,'EUR','2026-09-01','oversize' FROM generate_series(1,10001)",
      [workspaceId, accountId],
    );
    await expect(
      createFrozenTransactionSelection(drizzlePglite(pg, { schema }), workspaceId, {
        q: "oversize",
      }),
    ).rejects.toThrow("at most 10,000");
  });

  it("reports stale rows and applies only frozen current rows", async () => {
    const db = drizzlePglite(pg, { schema });
    const first = one(
      await db
        .select()
        .from(transactions)
        .where(sql`${transactions.workspaceId} = ${workspaceId}`)
        .limit(1),
    );
    const selection = await createFrozenTransactionSelection(db, workspaceId, {}, [first.id]);
    await db
      .update(transactions)
      .set({ version: 2 })
      .where(sql`${transactions.id} = ${first.id}`);
    const outcome = await executeFrozenBulk(db, {
      workspaceId,
      actorUserId: null,
      idempotencyKey: "bulk-stale",
      selectionId: selection.id,
      command: "excludeFromAnalytics",
      excluded: true,
    });
    expect(outcome.applied).toBe(0);
    expect(outcome.conflicts).toEqual([first.id]);
    expect(
      one(
        await db
          .select()
          .from(transactions)
          .where(sql`${transactions.id} = ${first.id}`)
          .limit(1),
      ).excludedFromAnalytics,
    ).toBe(false);
  });
});
