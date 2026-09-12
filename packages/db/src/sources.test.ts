import { eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import {
  dataSources,
  imports,
  sourceAccounts,
  sourceTransactionObservations,
  sourceTransactions,
  workspaces,
} from "./schema.js";
import { createMigratedDb, expectDbError, one, tableNames } from "./pglite-test-db.js";
import { isUuidV7, uuidv7 } from "./uuid.js";
import { TENANT_SETTING } from "./tenancy.js";

/**
 * Issue 3.1 â€” source ingestion schema.
 *
 * Applies the REAL shipped chain (0000â€“0007) to PGlite and proves, in order:
 *   1. all five tables exist with UUIDv7 defaults and sane initial state;
 *   2. status/type allowlists reject garbage on every table that has one;
 *   3. imports UNIQUE(workspace_id, idempotency_key) scopes re-submit claims
 *      per workspace (the Issue 3.6 claim);
 *   4. stable external ids are unique when present but NULL-exempt, so
 *      keyless CSV rows never collide (no fuzzy uniqueness, Issue 4.11);
 *   5. observations UNIQUE(import_id, row_number) pins one row per file row
 *      while manual (NULL import) rows stay exempt;
 *   6. FKs reject orphans and cascade/set-null exactly as documented;
 *   7. identical legitimate rows coexist (the acceptance fixture);
 *   8. repeated file hashes are allowed (Issue 3.8 warns, never blocks);
 *   9. the query indexes the worker/UI will need actually exist;
 *  10. RLS: A cannot read B on any of the five tables, missing context sees
 *      nothing, cross-workspace writes fail, and the app role has no bypass.
 */
describe("source ingestion schema (migration 0007)", () => {
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

  /** Fresh source + import chain owned by `ws`, via the owner role. */
  async function seedChain(ws: string, tag: string) {
    const db = drizzlePglite(pg, { schema });
    const source = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: ws, type: "csv_file", name: `Bank ${tag}` })
        .returning(),
    );
    const imp = one(
      await db
        .insert(imports)
        .values({
          workspaceId: ws,
          dataSourceId: source.id,
          idempotencyKey: `key-${tag}-${uuidv7()}`,
          fileName: `${tag}.csv`,
        })
        .returning(),
    );
    return { source, imp };
  }

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Sources A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Sources B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates all five tables with UUIDv7 defaults and sane initial state", async () => {
    const tables = await tableNames(pg);
    for (const t of [
      "data_sources",
      "imports",
      "source_accounts",
      "source_transactions",
      "source_transaction_observations",
    ]) {
      expect(tables).toContain(t);
    }

    const db = drizzlePglite(pg, { schema });
    const source = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: wsA, type: "csv_file", name: "Revolut CSV" })
        .returning(),
    );
    expect(isUuidV7(source.id)).toBe(true);
    expect(source.status).toBe("active");
    expect(source.metadata).toEqual({});
    expect(source.provider).toBeNull();
    expect(source.archivedAt).toBeNull();

    const imp = one(
      await db
        .insert(imports)
        .values({
          workspaceId: wsA,
          dataSourceId: source.id,
          idempotencyKey: `init-${uuidv7()}`,
        })
        .returning(),
    );
    expect(isUuidV7(imp.id)).toBe(true);
    expect(imp.status).toBe("pending");
    expect(imp.parserVersion).toBe("v1");
    expect(imp.rowCount).toBeNull();
    expect(imp.metadata).toEqual({});

    const account = one(
      await db
        .insert(sourceAccounts)
        .values({ workspaceId: wsA, dataSourceId: source.id, displayName: "Main" })
        .returning(),
    );
    expect(isUuidV7(account.id)).toBe(true);
    expect(account.firstSeenAt).toBeInstanceOf(Date);
    expect(account.lastSeenAt).toBeInstanceOf(Date);

    const txn = one(
      await db
        .insert(sourceTransactions)
        .values({
          workspaceId: wsA,
          dataSourceId: source.id,
          sourceAccountId: account.id,
        })
        .returning(),
    );
    expect(isUuidV7(txn.id)).toBe(true);
    expect(txn.currentStatus).toBe("observed");

    const obs = one(
      await db
        .insert(sourceTransactionObservations)
        .values({
          workspaceId: wsA,
          sourceTransactionId: txn.id,
          importId: imp.id,
          rowNumber: 1,
          rawHash: "hash-1",
          rawPayload: { date: "2026-01-01", amount: "12.50" },
        })
        .returning(),
    );
    expect(isUuidV7(obs.id)).toBe(true);
    expect(obs.observationType).toBe("file_row");
    expect(obs.rawPayload).toEqual({ date: "2026-01-01", amount: "12.50" });
  });

  it("rejects unknown status values on every guarded table", async () => {
    const db = drizzlePglite(pg, { schema });
    await expectDbError(
      db
        .insert(dataSources)
        .values({ workspaceId: wsA, type: "csv_file", name: "Bad", status: "flying" }),
      /data_sources_status_check/,
    );
    const { source } = await seedChain(wsA, `status-${uuidv7()}`);
    await expectDbError(
      db.insert(imports).values({
        workspaceId: wsA,
        dataSourceId: source.id,
        idempotencyKey: `bad-${uuidv7()}`,
        status: "teleporting",
      }),
      /imports_status_check/,
    );
    await expectDbError(
      db.insert(sourceTransactions).values({
        workspaceId: wsA,
        dataSourceId: source.id,
        currentStatus: "teleporting",
      }),
      /source_transactions_status_check/,
    );
    const txn = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: source.id })
        .returning(),
    );
    await expectDbError(
      db.insert(sourceTransactionObservations).values({
        workspaceId: wsA,
        sourceTransactionId: txn.id,
        rawHash: "h",
        observationType: "teleporting",
      }),
      /source_observations_type_check/,
    );
  });

  it("scopes the import idempotency claim per workspace", async () => {
    const db = drizzlePglite(pg, { schema });
    const key = `claim-${uuidv7()}`;
    const srcA = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: wsA, type: "csv_file", name: "Claim A" })
        .returning(),
    );
    const srcB = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: wsB, type: "csv_file", name: "Claim B" })
        .returning(),
    );
    await db.insert(imports).values({
      workspaceId: wsA,
      dataSourceId: srcA.id,
      idempotencyKey: key,
    });
    // Same workspace + same key: the re-submit claim collides.
    await expectDbError(
      db.insert(imports).values({
        workspaceId: wsA,
        dataSourceId: srcA.id,
        idempotencyKey: key,
      }),
      /duplicate key value violates unique constraint "imports_workspace_idempotency_uniq"/,
    );
    // Same key, other workspace: an independent tenant's own claim.
    await db.insert(imports).values({
      workspaceId: wsB,
      dataSourceId: srcB.id,
      idempotencyKey: key,
    });
    expect(await count("imports", "WHERE idempotency_key = $1", [key])).toBe("2");
  });

  it("keeps stable external ids unique when present but never blocks keyless rows", async () => {
    const db = drizzlePglite(pg, { schema });
    const srcA = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: wsA, type: "csv_file", name: `Ext A ${uuidv7()}` })
        .returning(),
    );
    const srcB = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: wsA, type: "csv_file", name: `Ext B ${uuidv7()}` })
        .returning(),
    );
    // Keyless CSV accounts coexist without limit.
    await db.insert(sourceAccounts).values({ workspaceId: wsA, dataSourceId: srcA.id });
    await db.insert(sourceAccounts).values({ workspaceId: wsA, dataSourceId: srcA.id });
    // A stable key collides only within its own source.
    await db
      .insert(sourceAccounts)
      .values({ workspaceId: wsA, dataSourceId: srcA.id, externalId: "acc-1" });
    await expectDbError(
      db
        .insert(sourceAccounts)
        .values({ workspaceId: wsA, dataSourceId: srcA.id, externalId: "acc-1" }),
      /duplicate key value violates unique constraint "source_accounts_source_external_uniq"/,
    );
    await db
      .insert(sourceAccounts)
      .values({ workspaceId: wsA, dataSourceId: srcB.id, externalId: "acc-1" });

    // Same rule for transactions: no fuzzy (date, amount, description) unique.
    await db.insert(sourceTransactions).values({ workspaceId: wsA, dataSourceId: srcA.id });
    await db.insert(sourceTransactions).values({ workspaceId: wsA, dataSourceId: srcA.id });
    await db
      .insert(sourceTransactions)
      .values({ workspaceId: wsA, dataSourceId: srcA.id, externalId: "txn-1" });
    await expectDbError(
      db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: srcA.id, externalId: "txn-1" }),
      /duplicate key value violates unique constraint "source_transactions_source_external_uniq"/,
    );
  });

  it("pins one observation per (import, row) while manual rows stay exempt", async () => {
    const db = drizzlePglite(pg, { schema });
    const { source, imp } = await seedChain(wsA, `obs-${uuidv7()}`);
    const txn = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: source.id })
        .returning(),
    );
    await db.insert(sourceTransactionObservations).values({
      workspaceId: wsA,
      sourceTransactionId: txn.id,
      importId: imp.id,
      rowNumber: 7,
      rawHash: "row-7",
    });
    await expectDbError(
      db.insert(sourceTransactionObservations).values({
        workspaceId: wsA,
        sourceTransactionId: txn.id,
        importId: imp.id,
        rowNumber: 7,
        rawHash: "row-7-again",
      }),
      /duplicate key value violates unique constraint "source_observations_import_row_uniq"/,
    );
    // Same row number in a different import: a deliberate re-import.
    const imp2 = one(
      await db
        .insert(imports)
        .values({
          workspaceId: wsA,
          dataSourceId: source.id,
          idempotencyKey: `re-${uuidv7()}`,
        })
        .returning(),
    );
    await db.insert(sourceTransactionObservations).values({
      workspaceId: wsA,
      sourceTransactionId: txn.id,
      importId: imp2.id,
      rowNumber: 7,
      rawHash: "row-7-reimport",
    });
    // Manual rows (no import/row) never collide with each other.
    await db.insert(sourceTransactionObservations).values({
      workspaceId: wsA,
      sourceTransactionId: txn.id,
      rawHash: "manual-1",
      observationType: "manual",
    });
    await db.insert(sourceTransactionObservations).values({
      workspaceId: wsA,
      sourceTransactionId: txn.id,
      rawHash: "manual-2",
      observationType: "manual",
    });
  });

  it("rejects orphans and cascades exactly as documented", async () => {
    const db = drizzlePglite(pg, { schema });
    const ghostSource = uuidv7();
    await expectDbError(
      db.insert(imports).values({
        workspaceId: wsA,
        dataSourceId: ghostSource,
        idempotencyKey: `orphan-${uuidv7()}`,
      }),
      /violates foreign key constraint/,
    );
    await expectDbError(
      db.insert(sourceTransactionObservations).values({
        workspaceId: wsA,
        sourceTransactionId: uuidv7(),
        rawHash: "orphan",
      }),
      /violates foreign key constraint/,
    );

    // Workspace delete removes the whole tenant chain.
    const doomedWs = one(
      await db
        .insert(workspaces)
        .values({ name: `Doomed ${uuidv7()}` })
        .returning(),
    ).id;
    const { source, imp } = await seedChain(doomedWs, `doom-${uuidv7()}`);
    const acct = one(
      await db
        .insert(sourceAccounts)
        .values({ workspaceId: doomedWs, dataSourceId: source.id })
        .returning(),
    );
    const txn = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: doomedWs, dataSourceId: source.id, sourceAccountId: acct.id })
        .returning(),
    );
    await db.insert(sourceTransactionObservations).values({
      workspaceId: doomedWs,
      sourceTransactionId: txn.id,
      importId: imp.id,
      rowNumber: 1,
      rawHash: "doom",
    });
    await db.delete(workspaces).where(eq(workspaces.id, doomedWs));
    expect(await count("data_sources", "WHERE workspace_id = $1", [doomedWs])).toBe("0");
    expect(await count("imports", "WHERE workspace_id = $1", [doomedWs])).toBe("0");
    expect(await count("source_accounts", "WHERE workspace_id = $1", [doomedWs])).toBe("0");
    expect(await count("source_transactions", "WHERE workspace_id = $1", [doomedWs])).toBe("0");
    expect(
      await count("source_transaction_observations", "WHERE workspace_id = $1", [doomedWs]),
    ).toBe("0");

    // Import delete keeps history: observations survive with import_id nulled.
    const { source: s2, imp: i2 } = await seedChain(wsA, `setnull-${uuidv7()}`);
    const t2 = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: s2.id })
        .returning(),
    );
    const o2 = one(
      await db
        .insert(sourceTransactionObservations)
        .values({
          workspaceId: wsA,
          sourceTransactionId: t2.id,
          importId: i2.id,
          rowNumber: 1,
          rawHash: "keep",
        })
        .returning(),
    );
    await db.delete(imports).where(eq(imports.id, i2.id));
    const kept = one(
      await q<{ import_id: string | null }>(
        `SELECT import_id FROM source_transaction_observations WHERE id = $1`,
        [o2.id],
      ),
    );
    expect(kept.import_id).toBeNull();

    // Source-account delete keeps transactions, unlinking them.
    const a3 = one(
      await db.insert(sourceAccounts).values({ workspaceId: wsA, dataSourceId: s2.id }).returning(),
    );
    const t3 = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: s2.id, sourceAccountId: a3.id })
        .returning(),
    );
    await db.delete(sourceAccounts).where(eq(sourceAccounts.id, a3.id));
    const unlinked = one(
      await q<{ source_account_id: string | null }>(
        `SELECT source_account_id FROM source_transactions WHERE id = $1`,
        [t3.id],
      ),
    );
    expect(unlinked.source_account_id).toBeNull();
  });

  it("preserves two legitimate identical purchases as distinct rows", async () => {
    const db = drizzlePglite(pg, { schema });
    const { source, imp } = await seedChain(wsA, `identical-${uuidv7()}`);
    const payload = { date: "2026-02-01", description: "COFFEE BAR", amount: "3.50" };
    const first = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: source.id })
        .returning(),
    );
    const second = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: source.id })
        .returning(),
    );
    expect(first.id).not.toBe(second.id);
    await db.insert(sourceTransactionObservations).values({
      workspaceId: wsA,
      sourceTransactionId: first.id,
      importId: imp.id,
      rowNumber: 1,
      rawHash: "identical-payload",
      rawPayload: payload,
    });
    await db.insert(sourceTransactionObservations).values({
      workspaceId: wsA,
      sourceTransactionId: second.id,
      importId: imp.id,
      rowNumber: 2,
      rawHash: "identical-payload",
      rawPayload: payload,
    });
    expect(
      await count("source_transaction_observations", "WHERE raw_hash = $1", ["identical-payload"]),
    ).toBe("2");
  });

  it("allows the same file hash on many imports (warning signal, not identity)", async () => {
    const db = drizzlePglite(pg, { schema });
    const { source } = await seedChain(wsA, `hash-${uuidv7()}`);
    const digest = "sha256:repeated-bytes";
    await db.insert(imports).values({
      workspaceId: wsA,
      dataSourceId: source.id,
      idempotencyKey: `dup-a-${uuidv7()}`,
      fileSha256: digest,
    });
    // Re-uploading the exact bytes with a fresh key must NOT collide.
    await db.insert(imports).values({
      workspaceId: wsA,
      dataSourceId: source.id,
      idempotencyKey: `dup-b-${uuidv7()}`,
      fileSha256: digest,
    });
    expect(await count("imports", "WHERE file_sha256 = $1", [digest])).toBe("2");
  });

  it("exposes the indexes the worker and UI query through", async () => {
    const rows = await q<{ tablename: string; indexname: string }>(
      `SELECT tablename, indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('data_sources','imports','source_accounts','source_transactions','source_transaction_observations')`,
    );
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      "imports_workspace_idempotency_uniq",
      "imports_workspace_created_idx",
      "imports_data_source_idx",
      "source_accounts_source_external_uniq",
      "source_transactions_source_external_uniq",
      "source_observations_import_row_idx",
      "source_observations_transaction_observed_idx",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("RLS: A cannot read or touch B's source rows", async () => {
    const db = drizzlePglite(pg, { schema });
    const marker = `secret-${uuidv7()}`;
    const srcB = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: wsB, type: "csv_file", name: marker })
        .returning(),
    );
    const impB = one(
      await db
        .insert(imports)
        .values({ workspaceId: wsB, dataSourceId: srcB.id, idempotencyKey: marker })
        .returning(),
    );
    const acctB = one(
      await db
        .insert(sourceAccounts)
        .values({ workspaceId: wsB, dataSourceId: srcB.id, displayName: marker })
        .returning(),
    );
    const txnB = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsB, dataSourceId: srcB.id, sourceAccountId: acctB.id })
        .returning(),
    );
    await db.insert(sourceTransactionObservations).values({
      workspaceId: wsB,
      sourceTransactionId: txnB.id,
      importId: impB.id,
      rowNumber: 1,
      rawHash: marker,
    });

    await asApp(wsA, async () => {
      expect(await count("data_sources", "WHERE name = $1", [marker])).toBe("0");
      expect(await count("imports", "WHERE idempotency_key = $1", [marker])).toBe("0");
      expect(await count("source_accounts", "WHERE display_name = $1", [marker])).toBe("0");
      expect(await count("source_transactions", "WHERE id = $1", [txnB.id])).toBe("0");
      expect(await count("source_transaction_observations", "WHERE raw_hash = $1", [marker])).toBe(
        "0",
      );
      const renamed = await qRaw("UPDATE data_sources SET name = 'hijack' WHERE id = $1", [
        srcB.id,
      ]);
      expect(renamed.affectedRows ?? renamed.rowCount).toBe(0);
      // Forging a row bound to B's workspace from A's context is denied.
      await expectDbError(
        q(
          `INSERT INTO imports (workspace_id, data_source_id, idempotency_key) VALUES ($1, $2, $3)`,
          [wsB, srcB.id, `forge-${uuidv7()}`],
        ),
        /new row violates row-level security policy for table "imports"/,
      );
      await expectDbError(
        q(
          `INSERT INTO source_transaction_observations (workspace_id, source_transaction_id, raw_hash) VALUES ($1, $2, $3)`,
          [wsB, txnB.id, `forge-${uuidv7()}`],
        ),
        /new row violates row-level security policy for table "source_transaction_observations"/,
      );
    });
    await asApp(wsB, async () => {
      expect(await count("data_sources", "WHERE name = $1", [marker])).toBe("1");
      expect(await count("source_transaction_observations", "WHERE raw_hash = $1", [marker])).toBe(
        "1",
      );
    });
  });

  it("RLS: missing tenant context sees no source rows", async () => {
    await asApp(null, async () => {
      for (const table of [
        "data_sources",
        "imports",
        "source_accounts",
        "source_transactions",
        "source_transaction_observations",
      ]) {
        expect(await count(table)).toBe("0");
      }
    });
  });

  it("grants the app role read/write on all five source tables", async () => {
    const grants = await q<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'moneo_app'
          AND table_name IN ('data_sources','imports','source_accounts','source_transactions','source_transaction_observations')
        ORDER BY table_name, privilege_type`,
    );
    const byTable = new Map<string, string[]>();
    for (const g of grants) {
      byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.privilege_type]);
    }
    for (const table of [
      "data_sources",
      "imports",
      "source_accounts",
      "source_transactions",
      "source_transaction_observations",
    ]) {
      expect(byTable.get(table)).toEqual(
        expect.arrayContaining(["SELECT", "INSERT", "UPDATE", "DELETE"]),
      );
    }
  });
});
