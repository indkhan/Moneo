import { eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import {
  accountBalanceSnapshots,
  accountSourceLinks,
  accounts,
  dataSources,
  imports,
  sourceAccounts,
  workspaces,
} from "./schema.js";
import { createMigratedDb, expectDbError, one, tableNames } from "./pglite-test-db.js";
import { TENANT_SETTING } from "./tenancy.js";
import { isUuidV7, uuidv7 } from "./uuid.js";

/**
 * Issue 4.1 â€” canonical account model (migration 0008).
 *
 * Applies the REAL shipped chain (0000â€“0008) to PGlite and proves, in order:
 *   1. all three tables exist with UUIDv7 defaults and sane initial state;
 *   2. type/relationship/source allowlists reject garbage;
 *   3. link PK (account_id, source_account_id) permits many-to-one merges
 *      while rejecting the same pair twice;
 *   4. snapshot amounts are nullable (unknown is not zero) and snapshots
 *      supersede by insert (no update-in-place);
 *   5. FKs cascade/set-null exactly as documented (workspace wipes the
 *      tenant chain; account removal takes its links/snapshots; import
 *      removal nulls provenance);
 *   6. archiving keeps the account readable (ordinary path, not delete);
 *   7. the query indexes the UI/worker will need actually exist;
 *   8. RLS: A cannot read B, missing context sees nothing, cross-workspace
 *      writes fail closed, and the app role has full grants.
 */
describe("canonical account model (migration 0008)", () => {
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

  /** Fresh source-account chain owned by `ws`, via the owner role. */
  async function seedSourceAccount(ws: string, tag: string) {
    const db = drizzlePglite(pg, { schema });
    const source = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: ws, type: "csv_file", name: `Bank ${tag}` })
        .returning(),
    );
    const account = one(
      await db
        .insert(sourceAccounts)
        .values({ workspaceId: ws, dataSourceId: source.id, displayName: `Source ${tag}` })
        .returning(),
    );
    return { source, account };
  }

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Accounts A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Accounts B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates all three tables with UUIDv7 defaults and sane initial state", async () => {
    const tables = await tableNames(pg);
    for (const t of ["accounts", "account_source_links", "account_balance_snapshots"]) {
      expect(tables).toContain(t);
    }

    const db = drizzlePglite(pg, { schema });
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: "Everyday checking", currencyCode: "EUR" })
        .returning(),
    );
    expect(isUuidV7(account.id)).toBe(true);
    expect(account.accountType).toBe("OTHER");
    expect(account.isSpendable).toBe(true);
    expect(account.includeInNetWorth).toBe(true);
    expect(account.metadata).toEqual({});
    expect(account.archivedAt).toBeNull();
    expect(account.createdAt).toBeInstanceOf(Date);

    const { account: source } = await seedSourceAccount(wsA, `init-${uuidv7()}`);
    const link = one(
      await db
        .insert(accountSourceLinks)
        .values({ workspaceId: wsA, accountId: account.id, sourceAccountId: source.id })
        .returning(),
    );
    expect(link.relationship).toBe("PRIMARY");

    const snapshot = one(
      await db
        .insert(accountBalanceSnapshots)
        .values({
          workspaceId: wsA,
          accountId: account.id,
          currencyCode: "EUR",
          currentAmountMinor: 12500,
        })
        .returning(),
    );
    expect(isUuidV7(snapshot.id)).toBe(true);
    expect(snapshot.source).toBe("manual");
    expect(snapshot.availableAmountMinor).toBeNull();
    expect(snapshot.metadata).toEqual({});
  });

  it("rejects unknown type/relationship/source values", async () => {
    const db = drizzlePglite(pg, { schema });
    await expectDbError(
      db
        .insert(accounts)
        .values({ workspaceId: wsA, name: "Bad", currencyCode: "EUR", accountType: "SPACESHIP" }),
      /accounts_type_check/,
    );
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Guarded ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    const { account: source } = await seedSourceAccount(wsA, `guard-${uuidv7()}`);
    await expectDbError(
      db.insert(accountSourceLinks).values({
        workspaceId: wsA,
        accountId: account.id,
        sourceAccountId: source.id,
        relationship: "TELEPORTED",
      }),
      /account_source_links_relationship_check/,
    );
    await expectDbError(
      db.insert(accountBalanceSnapshots).values({
        workspaceId: wsA,
        accountId: account.id,
        currencyCode: "EUR",
        source: "telepathy",
      }),
      /account_balance_snapshots_source_check/,
    );
  });

  it("links many source identities to one account but never the same pair twice", async () => {
    const db = drizzlePglite(pg, { schema });
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Merged ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    const first = await seedSourceAccount(wsA, `merge-a-${uuidv7()}`);
    const second = await seedSourceAccount(wsA, `merge-b-${uuidv7()}`);
    await db.insert(accountSourceLinks).values({
      workspaceId: wsA,
      accountId: account.id,
      sourceAccountId: first.account.id,
      relationship: "PRIMARY",
    });
    await db.insert(accountSourceLinks).values({
      workspaceId: wsA,
      accountId: account.id,
      sourceAccountId: second.account.id,
      relationship: "MERGED",
    });
    expect(await count("account_source_links", "WHERE account_id = $1", [account.id])).toBe("2");
    await expectDbError(
      db.insert(accountSourceLinks).values({
        workspaceId: wsA,
        accountId: account.id,
        sourceAccountId: first.account.id,
      }),
      /duplicate key value violates unique constraint "account_source_links_pk"/,
    );
  });

  it("treats missing balance as unknown and supersedes snapshots by insert", async () => {
    const db = drizzlePglite(pg, { schema });
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Unknown ${uuidv7()}`, currencyCode: "JPY" })
        .returning(),
    );
    // A snapshot with no amounts: the balance is unknown, never zero.
    const unknown = one(
      await db
        .insert(accountBalanceSnapshots)
        .values({ workspaceId: wsA, accountId: account.id, currencyCode: "JPY" })
        .returning(),
    );
    expect(unknown.currentAmountMinor).toBeNull();
    expect(unknown.availableAmountMinor).toBeNull();
    // Corrections supersede: a second row, not an update of the first.
    const newer = one(
      await db
        .insert(accountBalanceSnapshots)
        .values({
          workspaceId: wsA,
          accountId: account.id,
          currencyCode: "JPY",
          currentAmountMinor: 50000,
          source: "statement",
        })
        .returning(),
    );
    expect(newer.id).not.toBe(unknown.id);
    expect(await count("account_balance_snapshots", "WHERE account_id = $1", [account.id])).toBe(
      "2",
    );
    const latest = one(
      await db
        .select()
        .from(accountBalanceSnapshots)
        .where(eq(accountBalanceSnapshots.accountId, account.id))
        .orderBy(accountBalanceSnapshots.observedAt),
    );
    expect(latest.id).toBe(unknown.id);
  });

  it("cascades and nulls exactly as documented", async () => {
    const db = drizzlePglite(pg, { schema });

    // Workspace delete removes the whole tenant chain.
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
    ).id;
    await db.insert(accountBalanceSnapshots).values({
      workspaceId: doomedWs,
      accountId: doomedAccount,
      currencyCode: "EUR",
      currentAmountMinor: 100,
    });
    await db.delete(workspaces).where(eq(workspaces.id, doomedWs));
    expect(await count("accounts", "WHERE workspace_id = $1", [doomedWs])).toBe("0");
    expect(await count("account_balance_snapshots", "WHERE workspace_id = $1", [doomedWs])).toBe(
      "0",
    );

    // Account delete takes its links and snapshots (rebuildable projections).
    const { account: source } = await seedSourceAccount(wsA, `cascade-${uuidv7()}`);
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Cascade ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    await db.insert(accountSourceLinks).values({
      workspaceId: wsA,
      accountId: account.id,
      sourceAccountId: source.id,
    });
    await db.insert(accountBalanceSnapshots).values({
      workspaceId: wsA,
      accountId: account.id,
      currencyCode: "EUR",
      currentAmountMinor: 10,
    });
    await db.delete(accounts).where(eq(accounts.id, account.id));
    expect(await count("account_source_links", "WHERE account_id = $1", [account.id])).toBe("0");
    expect(await count("account_balance_snapshots", "WHERE account_id = $1", [account.id])).toBe(
      "0",
    );
    // The raw source observation survives: canonical state never deletes it.
    expect(await count("source_accounts", "WHERE id = $1", [source.id])).toBe("1");

    // Import delete keeps history: snapshots survive with source_import_id nulled.
    const db2 = drizzlePglite(pg, { schema });
    const keepAccount = one(
      await db2
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Keep ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    const seed = await seedSourceAccount(wsA, `keep-${uuidv7()}`);
    const imp = one(
      await db2
        .insert(imports)
        .values({
          workspaceId: wsA,
          dataSourceId: seed.source.id,
          idempotencyKey: `keep-${uuidv7()}`,
        })
        .returning(),
    );
    const snap = one(
      await db2
        .insert(accountBalanceSnapshots)
        .values({
          workspaceId: wsA,
          accountId: keepAccount.id,
          currencyCode: "EUR",
          currentAmountMinor: 42,
          source: "statement",
          sourceImportId: imp.id,
        })
        .returning(),
    );
    await db2.delete(imports).where(eq(imports.id, imp.id));
    const kept = one(
      await q<{ source_import_id: string | null }>(
        `SELECT source_import_id FROM account_balance_snapshots WHERE id = $1`,
        [snap.id],
      ),
    );
    expect(kept.source_import_id).toBeNull();
  });

  it("keeps archived accounts readable (archive, do not delete)", async () => {
    const db = drizzlePglite(pg, { schema });
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Archived ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    await db.update(accounts).set({ archivedAt: new Date() }).where(eq(accounts.id, account.id));
    const reread = one(await db.select().from(accounts).where(eq(accounts.id, account.id)));
    expect(reread.archivedAt).toBeInstanceOf(Date);
  });

  it("exposes the indexes the worker and UI query through", async () => {
    const rows = await q<{ tablename: string; indexname: string }>(
      `SELECT tablename, indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('accounts','account_source_links','account_balance_snapshots')`,
    );
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      "accounts_workspace_created_idx",
      "account_source_links_source_idx",
      "account_balance_snapshots_account_observed_idx",
      "account_balance_snapshots_workspace_created_idx",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("RLS: A cannot read or touch B's canonical accounts", async () => {
    const db = drizzlePglite(pg, { schema });
    const marker = `secret-${uuidv7()}`;
    const accountB = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsB, name: marker, currencyCode: "EUR" })
        .returning(),
    );
    await db.insert(accountBalanceSnapshots).values({
      workspaceId: wsB,
      accountId: accountB.id,
      currencyCode: "EUR",
      currentAmountMinor: 999,
    });

    await asApp(wsA, async () => {
      expect(await count("accounts", "WHERE name = $1", [marker])).toBe("0");
      expect(await count("account_balance_snapshots", "WHERE account_id = $1", [accountB.id])).toBe(
        "0",
      );
      const renamed = await qRaw("UPDATE accounts SET name = 'hijack' WHERE id = $1", [
        accountB.id,
      ]);
      expect(renamed.affectedRows ?? renamed.rowCount).toBe(0);
      await expectDbError(
        q(`INSERT INTO accounts (workspace_id, name, currency_code) VALUES ($1, $2, $3)`, [
          wsB,
          `forge-${uuidv7()}`,
          "EUR",
        ]),
        /new row violates row-level security policy for table "accounts"/,
      );
    });
    await asApp(wsB, async () => {
      expect(await count("accounts", "WHERE name = $1", [marker])).toBe("1");
    });
  });

  it("RLS: missing tenant context sees no canonical rows", async () => {
    await asApp(null, async () => {
      for (const table of ["accounts", "account_source_links", "account_balance_snapshots"]) {
        expect(await count(table)).toBe("0");
      }
    });
  });

  it("grants the app role read/write on all three canonical tables", async () => {
    const grants = await q<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'moneo_app'
          AND table_name IN ('accounts','account_source_links','account_balance_snapshots')
        ORDER BY table_name, privilege_type`,
    );
    const byTable = new Map<string, string[]>();
    for (const g of grants) {
      byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.privilege_type]);
    }
    for (const table of ["accounts", "account_source_links", "account_balance_snapshots"]) {
      expect(byTable.get(table)).toEqual(
        expect.arrayContaining(["SELECT", "INSERT", "UPDATE", "DELETE"]),
      );
    }
  });
});
