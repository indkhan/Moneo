import { eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import {
  accounts,
  dataSources,
  sourceTransactions,
  transactionSourceLinks,
  transactions,
  workspaces,
} from "./schema.js";
import { createMigratedDb, expectDbError, one, tableNames } from "./pglite-test-db.js";
import { TENANT_SETTING } from "./tenancy.js";
import { isUuidV7, uuidv7 } from "./uuid.js";

/**
 * Issue 4.2 â€” canonical transaction model (migration 0009).
 *
 * Applies the REAL shipped chain (0000â€“0009) to PGlite and proves, in order:
 *   1. both tables exist with UUIDv7 defaults and sane initial state;
 *   2. amount/direction/status checks reject zero, negative, signed-float
 *      style, and unknown values;
 *   3. link PK (transaction_id, source_transaction_id) permits pending +
 *      posted predecessors on one canonical row while rejecting repeats;
 *   4. an account with history cannot be deleted (archive is the path);
 *      workspace removal still wipes the tenant chain;
 *   5. the two cursor indexes from the epoch spec actually exist;
 *   6. RLS: A cannot read B, missing context sees nothing, cross-workspace
 *      writes fail closed, and the app role has full grants.
 */
describe("canonical transaction model (migration 0009)", () => {
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

  async function seedAccount(ws: string, tag: string) {
    const db = drizzlePglite(pg, { schema });
    return one(
      await db
        .insert(accounts)
        .values({ workspaceId: ws, name: `Account ${tag}`, currencyCode: "EUR" })
        .returning(),
    );
  }

  async function seedSourceTransaction(ws: string, tag: string) {
    const db = drizzlePglite(pg, { schema });
    const source = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: ws, type: "csv_file", name: `Bank ${tag}` })
        .returning(),
    );
    return one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: ws, dataSourceId: source.id })
        .returning(),
    );
  }

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Transactions A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Transactions B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates both tables with UUIDv7 defaults and sane initial state", async () => {
    const tables = await tableNames(pg);
    expect(tables).toContain("transactions");
    expect(tables).toContain("transaction_source_links");

    const db = drizzlePglite(pg, { schema });
    const account = await seedAccount(wsA, `init-${uuidv7()}`);
    const txn = one(
      await db
        .insert(transactions)
        .values({
          workspaceId: wsA,
          accountId: account.id,
          direction: "debit",
          amountMinor: 1550,
          currencyCode: "EUR",
          effectiveDate: "2026-08-15",
          description: "COFFEE BAR",
        })
        .returning(),
    );
    expect(isUuidV7(txn.id)).toBe(true);
    expect(txn.status).toBe("POSTED");
    expect(txn.excludedFromAnalytics).toBe(false);
    expect(txn.counterpartyId).toBeNull();
    expect(txn.categoryId).toBeNull();
    expect(txn.note).toBeNull();
    expect(txn.archivedAt).toBeNull();

    const source = await seedSourceTransaction(wsA, `init-${uuidv7()}`);
    const link = one(
      await db
        .insert(transactionSourceLinks)
        .values({ workspaceId: wsA, transactionId: txn.id, sourceTransactionId: source.id })
        .returning(),
    );
    expect(link.relationship).toBe("PRIMARY");
  });

  it("rejects non-positive amounts and unknown direction/status values", async () => {
    const db = drizzlePglite(pg, { schema });
    const account = await seedAccount(wsA, `guard-${uuidv7()}`);
    const base = {
      workspaceId: wsA,
      accountId: account.id,
      direction: "debit" as const,
      amountMinor: 100,
      currencyCode: "EUR",
      effectiveDate: "2026-08-15",
      description: "GUARDED",
    };
    await expectDbError(
      db.insert(transactions).values({ ...base, amountMinor: 0 }),
      /transactions_amount_check/,
    );
    await expectDbError(
      db.insert(transactions).values({ ...base, amountMinor: -50 }),
      /transactions_amount_check/,
    );
    await expectDbError(
      db.insert(transactions).values({ ...base, direction: "OUTFLOW" }),
      /transactions_direction_check/,
    );
    await expectDbError(
      db.insert(transactions).values({ ...base, status: "SETTLED" }),
      /transactions_status_check/,
    );
    const txn = one(await db.insert(transactions).values(base).returning());
    const source = await seedSourceTransaction(wsA, `guard-${uuidv7()}`);
    await expectDbError(
      db.insert(transactionSourceLinks).values({
        workspaceId: wsA,
        transactionId: txn.id,
        sourceTransactionId: source.id,
        relationship: "TELEPORTED",
      }),
      /transaction_source_links_relationship_check/,
    );
  });

  it("keeps pending and posted predecessors on one row but never the same link twice", async () => {
    const db = drizzlePglite(pg, { schema });
    const account = await seedAccount(wsA, `predecessor-${uuidv7()}`);
    const txn = one(
      await db
        .insert(transactions)
        .values({
          workspaceId: wsA,
          accountId: account.id,
          direction: "credit",
          amountMinor: 200000,
          currencyCode: "EUR",
          effectiveDate: "2026-08-01",
          description: "SALARY",
        })
        .returning(),
    );
    const pending = await seedSourceTransaction(wsA, `pending-${uuidv7()}`);
    const posted = await seedSourceTransaction(wsA, `posted-${uuidv7()}`);
    await db.insert(transactionSourceLinks).values({
      workspaceId: wsA,
      transactionId: txn.id,
      sourceTransactionId: pending.id,
      relationship: "PENDING_PREDECESSOR",
    });
    await db.insert(transactionSourceLinks).values({
      workspaceId: wsA,
      transactionId: txn.id,
      sourceTransactionId: posted.id,
      relationship: "PRIMARY",
    });
    expect(await count("transaction_source_links", "WHERE transaction_id = $1", [txn.id])).toBe(
      "2",
    );
    await expectDbError(
      db.insert(transactionSourceLinks).values({
        workspaceId: wsA,
        transactionId: txn.id,
        sourceTransactionId: pending.id,
      }),
      /duplicate key value violates unique constraint "transaction_source_links_pk"/,
    );
  });

  it("refuses to delete an account with history but wipes the tenant chain", async () => {
    const db = drizzlePglite(pg, { schema });

    const account = await seedAccount(wsA, `guarded-${uuidv7()}`);
    await db.insert(transactions).values({
      workspaceId: wsA,
      accountId: account.id,
      direction: "debit",
      amountMinor: 100,
      currencyCode: "EUR",
      effectiveDate: "2026-08-15",
      description: "HISTORY",
    });
    await expectDbError(
      db.delete(accounts).where(eq(accounts.id, account.id)),
      /violates foreign key constraint/,
    );
    // History survived the refused delete; archiving is the ordinary path.
    expect(await count("transactions", "WHERE account_id = $1", [account.id])).toBe("1");

    // Workspace removal still wipes the whole tenant chain.
    const doomedWs = one(
      await db
        .insert(workspaces)
        .values({ name: `Doomed ${uuidv7()}` })
        .returning(),
    ).id;
    const doomedAccount = one(
      await db
        .insert(accounts)
        .values({ workspaceId: doomedWs, name: "Doomed", currencyCode: "EUR" })
        .returning(),
    );
    const doomedTxn = one(
      await db
        .insert(transactions)
        .values({
          workspaceId: doomedWs,
          accountId: doomedAccount.id,
          direction: "debit",
          amountMinor: 100,
          currencyCode: "EUR",
          effectiveDate: "2026-08-15",
          description: "DOOMED",
        })
        .returning(),
    );
    expect(doomedTxn.id).toBeDefined();
    await db.delete(workspaces).where(eq(workspaces.id, doomedWs));
    expect(await count("transactions", "WHERE workspace_id = $1", [doomedWs])).toBe("0");
    expect(
      await count("transaction_source_links", "WHERE workspace_id = $1", [doomedWs]),
    ).toBe("0");
    expect(await count("accounts", "WHERE workspace_id = $1", [doomedWs])).toBe("0");
  });

  it("exposes the two cursor indexes from the epoch spec", async () => {
    const rows = await q<{ tablename: string; indexname: string; indexdef: string }>(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('transactions','transaction_source_links')`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.has("transactions_workspace_date_idx")).toBe(true);
    expect(byName.has("transactions_account_date_idx")).toBe(true);
    expect(byName.get("transactions_workspace_date_idx")).toMatch(
      /workspace_id.*effective_date/,
    );
    expect(byName.get("transactions_account_date_idx")).toMatch(/account_id.*effective_date/);
  });

  it("RLS: A cannot read or touch B's canonical transactions", async () => {
    const db = drizzlePglite(pg, { schema });
    const marker = `secret-${uuidv7()}`;
    const accountB = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsB, name: `Account ${marker}`, currencyCode: "EUR" })
        .returning(),
    );
    const txnB = one(
      await db
        .insert(transactions)
        .values({
          workspaceId: wsB,
          accountId: accountB.id,
          direction: "debit",
          amountMinor: 999,
          currencyCode: "EUR",
          effectiveDate: "2026-08-15",
          description: marker,
        })
        .returning(),
    );

    await asApp(wsA, async () => {
      expect(await count("transactions", "WHERE description = $1", [marker])).toBe("0");
      const renamed = await qRaw("UPDATE transactions SET description = 'hijack' WHERE id = $1", [
        txnB.id,
      ]);
      expect(renamed.affectedRows ?? renamed.rowCount).toBe(0);
      const ownAccount = one(
        await q<{ id: string }>(`SELECT id FROM accounts WHERE workspace_id = $1 LIMIT 1`, [wsA]),
      ).id;
      // Forging a row bound to B's workspace from A's context is denied.
      await expectDbError(
        q(
          `INSERT INTO transactions (workspace_id, account_id, direction, amount_minor, currency_code, effective_date, description)
           VALUES ($1, $2, 'debit', 100, 'EUR', '2026-08-15', $3)`,
          [wsB, ownAccount, `forge-${uuidv7()}`],
        ),
        /new row violates row-level security policy for table "transactions"/,
      );
    });
    await asApp(wsB, async () => {
      expect(await count("transactions", "WHERE description = $1", [marker])).toBe("1");
    });
  });

  it("RLS: missing tenant context sees no canonical rows", async () => {
    await asApp(null, async () => {
      for (const table of ["transactions", "transaction_source_links"]) {
        expect(await count(table)).toBe("0");
      }
    });
  });

  it("grants the app role read/write on both canonical tables", async () => {
    const grants = await q<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'moneo_app'
          AND table_name IN ('transactions','transaction_source_links')
        ORDER BY table_name, privilege_type`,
    );
    const byTable = new Map<string, string[]>();
    for (const g of grants) {
      byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.privilege_type]);
    }
    for (const table of ["transactions", "transaction_source_links"]) {
      expect(byTable.get(table)).toEqual(
        expect.arrayContaining(["SELECT", "INSERT", "UPDATE", "DELETE"]),
      );
    }
  });
});
