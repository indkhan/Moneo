import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import {
  accounts,
  dataSources,
  imports,
  sourceTransactionObservations,
  sourceTransactions,
  transactionSourceLinks,
  transactions,
  workspaces,
} from "./schema.js";
import { getTransactionDetail } from "./transaction-detail.js";
import { createMigratedDb, one } from "./pglite-test-db.js";
import { TENANT_SETTING } from "./tenancy.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 4.8 — transaction detail query.
 *
 * Proves against the REAL migrated schema: canonical fields resolve with
 * the account name; every source link carries its observations oldest-first
 * with import file names and verbatim raw payloads; manual rows (no import,
 * no observation) still surface; unknown and foreign ids return null; and
 * the app role stays tenant-safe through the same function.
 */
describe("transaction detail query (issue 4.8)", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;

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

  beforeAll(async () => {
    pg = await createMigratedDb("0012_command_input_hash");
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Detail A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Detail B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  async function seedFullChain(ws: string, tag: string) {
    const db = drizzlePglite(pg, { schema });
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: ws, name: `Everyday ${tag}`, currencyCode: "EUR" })
        .returning(),
    );
    const txn = one(
      await db
        .insert(transactions)
        .values({
          workspaceId: ws,
          accountId: account.id,
          direction: "debit",
          amountMinor: 1550,
          currencyCode: "EUR",
          effectiveDate: "2026-08-15",
          description: "COFFEE BAR",
        })
        .returning(),
    );
    const source = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: ws, type: "csv_file", name: `Revolut ${tag}` })
        .returning(),
    );
    const imp = one(
      await db
        .insert(imports)
        .values({
          workspaceId: ws,
          dataSourceId: source.id,
          idempotencyKey: `detail-${tag}-${uuidv7()}`,
          fileName: "august.csv",
        })
        .returning(),
    );
    const sourceTxn = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: ws, dataSourceId: source.id })
        .returning(),
    );
    await db.insert(transactionSourceLinks).values({
      workspaceId: ws,
      transactionId: txn.id,
      sourceTransactionId: sourceTxn.id,
      relationship: "PRIMARY",
    });
    const rawPayload = { date: "15.08.2026", description: "COFFEE BAR", amount: "15,50" };
    await db.insert(sourceTransactionObservations).values({
      workspaceId: ws,
      sourceTransactionId: sourceTxn.id,
      importId: imp.id,
      rowNumber: 7,
      rawHash: `hash-${tag}`,
      rawPayload,
    });
    return { account, txn, source, imp, sourceTxn, rawPayload };
  }

  it("resolves canonical fields with account name and verbatim provenance", async () => {
    const db = drizzlePglite(pg, { schema });
    const tag = uuidv7();
    const { txn, rawPayload } = await seedFullChain(wsA, tag);

    const detail = await getTransactionDetail(db, wsA, txn.id);
    expect(detail?.transaction.id).toBe(txn.id);
    expect(detail?.transaction.amountMinor).toBe(1550);
    expect(detail?.accountName).toBe(`Everyday ${tag}`);
    expect(detail?.sources).toHaveLength(1);
    expect(detail?.sources[0]).toMatchObject({
      relationship: "PRIMARY",
      dataSourceName: `Revolut ${tag}`,
      fileName: "august.csv",
      rawPayload,
    });
    expect(detail?.sources[0]?.importId).toEqual(expect.any(String));
  });

  it("returns empty sources for manual rows and null for unknown ids", async () => {
    const db = drizzlePglite(pg, { schema });
    const account = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Manual ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    const manual = one(
      await db
        .insert(transactions)
        .values({
          workspaceId: wsA,
          accountId: account.id,
          direction: "debit",
          amountMinor: 1500,
          currencyCode: "EUR",
          effectiveDate: "2026-08-16",
          description: "CASH COFFEE",
        })
        .returning(),
    );
    const detail = await getTransactionDetail(db, wsA, manual.id);
    expect(detail?.sources).toEqual([]);
    expect(await getTransactionDetail(db, wsA, uuidv7())).toBeNull();
  });

  it("never resolves a foreign workspace row, including under the app role", async () => {
    const db = drizzlePglite(pg, { schema });
    const { txn } = await seedFullChain(wsB, uuidv7());
    expect(await getTransactionDetail(db, wsA, txn.id)).toBeNull();
    await asApp(wsA, async () => {
      expect(await getTransactionDetail(db, wsA, txn.id)).toBeNull();
    });
    await asApp(wsB, async () => {
      expect((await getTransactionDetail(db, wsB, txn.id))?.transaction.id).toBe(txn.id);
    });
  });
});
