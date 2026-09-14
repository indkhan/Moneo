import { and, eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { accounts, categories, counterparties, transactions, workspaces } from "./schema.js";
import { createMigratedDb, expectDbError, one } from "./pglite-test-db.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 5.2 â€” optimistic entity versions (migration 0015).
 *
 * Applies the REAL shipped chain (0000â€“0015) to PGlite and proves:
 *   1. new rows on all four mutable tables default to version 1;
 *   2. versions below 1 are rejected by the check constraints;
 *   3. the compare-and-swap pattern Issues 5.3/5.4 rely on works: a second
 *      writer holding a stale version updates zero rows instead of
 *      overwriting the first writer (the Epoch 5 two-tab acceptance at the
 *      SQL level; the command layer turns "zero rows" into VERSION_CONFLICT).
 */
describe("optimistic entity versions (migration 0015)", () => {
  let pg!: PGlite;
  let ws!: string;

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    ws = one(await db.insert(workspaces).values({ name: "Versions" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("defaults new rows to version 1", async () => {
    const db = drizzlePglite(pg, { schema });
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: ws, name: `Account ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    expect(account.version).toBe(1);
    const txn = one(
      await db
        .insert(transactions)
        .values({
          workspaceId: ws,
          accountId: account.id,
          direction: "debit",
          amountMinor: 100,
          currencyCode: "EUR",
          effectiveDate: "2026-08-15",
          description: `versioned-${uuidv7()}`,
        })
        .returning(),
    );
    expect(txn.version).toBe(1);
    const category = one(
      await db
        .insert(categories)
        .values({ workspaceId: ws, name: `Cat ${uuidv7()}` })
        .returning(),
    );
    expect(category.version).toBe(1);
    const counterparty = one(
      await db
        .insert(counterparties)
        .values({
          workspaceId: ws,
          normalizedName: `merchant-${uuidv7()}`,
          displayName: "Merchant",
        })
        .returning(),
    );
    expect(counterparty.version).toBe(1);
  });

  it("rejects versions below 1", async () => {
    const db = drizzlePglite(pg, { schema });
    await expectDbError(
      db.insert(categories).values({ workspaceId: ws, name: `Bad ${uuidv7()}`, version: 0 }),
      /categories_version_check/,
    );
    await expectDbError(qInsertTransactionWithVersion(db, 0), /transactions_version_check/);
  });

  async function qInsertTransactionWithVersion(
    db: ReturnType<typeof drizzlePglite>,
    version: number,
  ) {
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: ws, name: `Account ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    return db.insert(transactions).values({
      workspaceId: ws,
      accountId: account.id,
      direction: "debit",
      amountMinor: 100,
      currencyCode: "EUR",
      effectiveDate: "2026-08-15",
      description: `bad-version-${uuidv7()}`,
      version,
    });
  }

  it("lets only the holder of the current version win (two-tab acceptance)", async () => {
    const db = drizzlePglite(pg, { schema });
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: ws, name: `Account ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    const txn = one(
      await db
        .insert(transactions)
        .values({
          workspaceId: ws,
          accountId: account.id,
          direction: "debit",
          amountMinor: 100,
          currencyCode: "EUR",
          effectiveDate: "2026-08-15",
          description: `conflict-${uuidv7()}`,
        })
        .returning(),
    );
    // Tab A and Tab B both read version 1.
    const tabAVersion = txn.version;
    const tabBVersion = txn.version;

    // Tab A writes first: guarded bump 1 â†’ 2 touches exactly one row.
    const tabAWrites = await db
      .update(transactions)
      .set({ note: "tab A", version: tabAVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(transactions.workspaceId, ws),
          eq(transactions.id, txn.id),
          eq(transactions.version, tabAVersion),
        ),
      )
      .returning({ id: transactions.id });
    expect(tabAWrites).toHaveLength(1);

    // Tab B submits its stale version: zero rows, never a silent overwrite.
    const tabBWrites = await db
      .update(transactions)
      .set({ note: "tab B", version: tabBVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(transactions.workspaceId, ws),
          eq(transactions.id, txn.id),
          eq(transactions.version, tabBVersion),
        ),
      )
      .returning({ id: transactions.id });
    expect(tabBWrites).toHaveLength(0);

    const current = one(
      await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.workspaceId, ws), eq(transactions.id, txn.id))),
    );
    expect(current.note).toBe("tab A");
    expect(current.version).toBe(2);
    // Sanity: raw SQL sees the same guard (commands use drizzle, same semantics).
    const raw = await pg.query(
      `UPDATE transactions SET note = 'raw' WHERE id = $1 AND version = $2`,
      [txn.id, tabBVersion],
    );
    expect(raw.affectedRows ?? raw.rowCount).toBe(0);
  });
});
