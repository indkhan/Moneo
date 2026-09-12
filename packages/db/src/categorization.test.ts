import { eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import {
  accounts,
  categories,
  counterparties,
  systemCategories,
  tags,
  transactionRelations,
  transactionTags,
  transactions,
  workspaces,
} from "./schema.js";
import { createMigratedDb, expectDbError, one, tableNames } from "./pglite-test-db.js";
import { seedSystemCategories, SYSTEM_CATEGORIES } from "./system-categories.js";
import { TENANT_SETTING } from "./tenancy.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 5.1 â€” categorization schema (migration 0014).
 *
 * Applies the REAL shipped chain (0000â€“0014) to PGlite and proves, in order:
 *   1. all six tables exist and the global taxonomy seeds idempotently;
 *   2. names are unique per workspace but reusable across workspaces;
 *   3. kind allowlists reject garbage on categories and system rows;
 *   4. transaction_tags PK rejects a repeated tag; relations reject
 *      self-links and unknown types;
 *   5. workspace removal cascades tenant rows while system rows survive;
 *   6. RLS: A cannot read B, missing context sees nothing on tenant tables,
 *      cross-workspace writes fail closed, system rows stay globally readable.
 */
describe("categorization schema (migration 0014)", () => {
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

  async function seedAccount(ws: string) {
    const db = drizzlePglite(pg, { schema });
    return one(
      await db
        .insert(accounts)
        .values({ workspaceId: ws, name: `Account ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
  }

  async function seedTransaction(ws: string, accountId: string, description: string) {
    const db = drizzlePglite(pg, { schema });
    return one(
      await db
        .insert(transactions)
        .values({
          workspaceId: ws,
          accountId,
          direction: "debit",
          amountMinor: 100,
          currencyCode: "EUR",
          effectiveDate: "2026-08-15",
          description,
        })
        .returning(),
    );
  }

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    await seedSystemCategories(db);
    wsA = one(await db.insert(workspaces).values({ name: "Categories A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Categories B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates all six tables and seeds the global taxonomy idempotently", async () => {
    const tables = await tableNames(pg);
    for (const table of [
      "system_categories",
      "categories",
      "counterparties",
      "tags",
      "transaction_tags",
      "transaction_relations",
    ]) {
      expect(tables).toContain(table);
    }
    const db = drizzlePglite(pg, { schema });
    expect(await count("system_categories")).toBe(String(SYSTEM_CATEGORIES.length));
    // Re-seeding converges: same row count, updated content, no duplicates.
    await seedSystemCategories(db);
    expect(await count("system_categories")).toBe(String(SYSTEM_CATEGORIES.length));
    const groceries = one(
      await db.select().from(systemCategories).where(eq(systemCategories.code, "groceries")),
    );
    expect(groceries.kind).toBe("expense");
  });

  it("scopes category/tag/counterparty names per workspace", async () => {
    const db = drizzlePglite(pg, { schema });
    const name = `Groceries ${uuidv7()}`;
    await db.insert(categories).values({ workspaceId: wsA, name, kind: "expense" });
    // Same workspace, same name: rejected.
    await expectDbError(
      db.insert(categories).values({ workspaceId: wsA, name, kind: "expense" }),
      /duplicate key|unique/i,
    );
    // Other workspace, same name: allowed.
    await db.insert(categories).values({ workspaceId: wsB, name, kind: "expense" });

    const tag = `trip-${uuidv7()}`;
    await db.insert(tags).values({ workspaceId: wsA, name: tag });
    await expectDbError(
      db.insert(tags).values({ workspaceId: wsA, name: tag }),
      /duplicate key|unique/i,
    );
    await db.insert(tags).values({ workspaceId: wsB, name: tag });

    const merchant = `lidl-${uuidv7()}`;
    await db
      .insert(counterparties)
      .values({ workspaceId: wsA, normalizedName: merchant, displayName: "Lidl" });
    await expectDbError(
      db
        .insert(counterparties)
        .values({ workspaceId: wsA, normalizedName: merchant, displayName: "Lidl 2" }),
      /duplicate key|unique/i,
    );
    await db
      .insert(counterparties)
      .values({ workspaceId: wsB, normalizedName: merchant, displayName: "Lidl" });
  });

  it("rejects unknown kinds, repeated tags, and self-relations", async () => {
    const db = drizzlePglite(pg, { schema });
    await expectDbError(
      db
        .insert(categories)
        .values({ workspaceId: wsA, name: `Bad ${uuidv7()}`, kind: "lottery" }),
      /categories_kind_check/,
    );

    const account = await seedAccount(wsA);
    const txn = await seedTransaction(wsA, account.id, `tagged-${uuidv7()}`);
    const tag = one(
      await db.insert(tags).values({ workspaceId: wsA, name: `tag-${uuidv7()}` }).returning(),
    );
    await db
      .insert(transactionTags)
      .values({ workspaceId: wsA, transactionId: txn.id, tagId: tag.id });
    await expectDbError(
      db
        .insert(transactionTags)
        .values({ workspaceId: wsA, transactionId: txn.id, tagId: tag.id }),
      /duplicate key|unique/i,
    );

    const other = await seedTransaction(wsA, account.id, `other-${uuidv7()}`);
    await expectDbError(
      db.insert(transactionRelations).values({
        workspaceId: wsA,
        fromTransactionId: txn.id,
        toTransactionId: txn.id,
      }),
      /transaction_relations_no_self_check/,
    );
    await expectDbError(
      db.insert(transactionRelations).values({
        workspaceId: wsA,
        fromTransactionId: txn.id,
        toTransactionId: other.id,
        relationType: "MARRIED",
      }),
      /transaction_relations_type_check/,
    );
  });

  it("cascades tenant rows on workspace removal but keeps system rows", async () => {
    const db = drizzlePglite(pg, { schema });
    const doomed = one(
      await db.insert(workspaces).values({ name: `Doomed ${uuidv7()}` }).returning(),
    );
    const category = one(
      await db
        .insert(categories)
        .values({ workspaceId: doomed.id, name: `Doom ${uuidv7()}` })
        .returning(),
    );
    expect(category.workspaceId).toBe(doomed.id);
    await db
      .insert(counterparties)
      .values({
        workspaceId: doomed.id,
        normalizedName: `doom-${uuidv7()}`,
        displayName: "Doom",
      });
    await db.insert(tags).values({ workspaceId: doomed.id, name: `doom-${uuidv7()}` });
    await db.delete(workspaces).where(eq(workspaces.id, doomed.id));
    expect(await count("categories", "WHERE workspace_id = $1", [doomed.id])).toBe("0");
    expect(await count("counterparties", "WHERE workspace_id = $1", [doomed.id])).toBe("0");
    expect(await count("tags", "WHERE workspace_id = $1", [doomed.id])).toBe("0");
    expect(await count("system_categories")).toBe(String(SYSTEM_CATEGORIES.length));
  });

  it("RLS: A cannot read or touch B's categories", async () => {
    const db = drizzlePglite(pg, { schema });
    const marker = `secret-${uuidv7()}`;
    await db.insert(categories).values({ workspaceId: wsB, name: marker });
    await db.insert(tags).values({ workspaceId: wsB, name: marker });

    await asApp(wsA, async () => {
      expect(await count("categories", "WHERE name = $1", [marker])).toBe("0");
      expect(await count("tags", "WHERE name = $1", [marker])).toBe("0");
      await expectDbError(
        q(`INSERT INTO categories (workspace_id, name) VALUES ($1, $2)`, [wsB, marker]),
        /new row violates row-level security policy for table "categories"/,
      );
    });
    await asApp(wsB, async () => {
      expect(await count("categories", "WHERE name = $1", [marker])).toBe("1");
      expect(await count("tags", "WHERE name = $1", [marker])).toBe("1");
    });
  });

  it("RLS: missing tenant context sees no tenant rows but reads system rows", async () => {
    await asApp(null, async () => {
      for (const table of [
        "categories",
        "counterparties",
        "tags",
        "transaction_tags",
        "transaction_relations",
      ]) {
        expect(await count(table)).toBe("0");
      }
      // Global taxonomy stays readable: it carries no tenant boundary.
      expect(await count("system_categories")).toBe(String(SYSTEM_CATEGORIES.length));
    });
  });

  it("grants the app role read/write on tenant tables and read on system rows", async () => {
    const grants = await q<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'moneo_app'
          AND table_name IN ('categories','counterparties','tags','transaction_tags','transaction_relations','system_categories')
        ORDER BY table_name, privilege_type`,
    );
    const byTable = new Map<string, string[]>();
    for (const g of grants) {
      byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.privilege_type]);
    }
    for (const table of [
      "categories",
      "counterparties",
      "tags",
      "transaction_tags",
      "transaction_relations",
    ]) {
      expect(byTable.get(table)).toEqual(
        expect.arrayContaining(["SELECT", "INSERT", "UPDATE", "DELETE"]),
      );
    }
    expect(byTable.get("system_categories")).toEqual(expect.arrayContaining(["SELECT"]));
  });
});
