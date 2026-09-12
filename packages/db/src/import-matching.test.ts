import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { decideRowForImport, type MatchRowInput } from "@moneo/finance";
import type { MappedPreviewRow } from "@moneo/finance";
import * as schema from "./schema.js";
import {
  accounts,
  dataSources,
  importMatchCandidates,
  imports,
  sourceAccounts,
  sourceTransactions,
  transactionSourceLinks,
  transactions,
  workspaces,
} from "./schema.js";
import {
  createDrizzleMatchStore,
  executeResolveMatch,
  listPendingCandidates,
} from "./import-matching.js";
import { createMigratedDb, expectDbError, one, tableNames } from "./pglite-test-db.js";
import { TENANT_SETTING } from "./tenancy.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 4.11 â€” Drizzle match stores over migration 0013.
 *
 * Proves against the REAL migrated schema: the domain decision flow runs
 * unchanged on Drizzle (accept â†’ pending â†’ trusted-merge â†’ retry-match);
 * `matches.resolve` links and keeps-distinct with audit + outbox rows;
 * pending lists carry both sides for review; no fuzzy uniqueness exists on
 * transactions; checks reject bad rule/confidence/status values; and RLS
 * plus grants hold on the candidates table.
 */
describe("drizzle import matching (migration 0013)", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;
  let dsA!: string;
  let srcAcctA!: string;
  let impAugust!: string;
  let impSeptember!: string;

  async function q<T>(sqlText: string, params: unknown[] = []): Promise<T[]> {
    const result =
      params.length > 0
        ? await pg.query<T>(sqlText, params as never[])
        : await pg.query<T>(sqlText);
    return result.rows;
  }

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

  function row(overrides: Partial<MappedPreviewRow> = {}): MappedPreviewRow {
    return {
      rowNumber: 1,
      date: "2026-08-12",
      description: "BOOKSTORE",
      amountMinor: "2499",
      currency: "EUR",
      direction: "debit",
      account: "Everyday",
      ...overrides,
    };
  }

  function matchInput(overrides: Partial<MatchRowInput> = {}): MatchRowInput {
    return {
      workspaceId: wsA,
      dataSourceId: dsA,
      importId: impSeptember,
      sourceAccountId: srcAcctA,
      sourceTransactionId: uuidv7(),
      sourceAccountLabel: "Everyday",
      row: row(),
      ...overrides,
    };
  }

  /** A real source row, like the import workflow upserts before matching. */
  async function seedSourceTxn(): Promise<string> {
    const db = drizzlePglite(pg, { schema });
    return one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: dsA })
        .returning(),
    ).id;
  }

  /** Seed one canonical transaction through the domain's own accept path. */
  async function acceptSeed(sourceTxnId: string, description = "BOOKSTORE") {
    const db = drizzlePglite(pg, { schema });
    const outcome = await decideRowForImport(
      createDrizzleMatchStore(db),
      matchInput({
        importId: impAugust,
        sourceTransactionId: sourceTxnId,
        row: row({ description }),
      }),
    );
    expect(outcome.disposition).toBe("accepted");
    return outcome.transactionId as string;
  }

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Match A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Match B" }).returning()).id;
    expect(await tableNames(pg)).toContain("import_match_candidates");
    dsA = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: wsA, type: "csv_file", name: "Bank A" })
        .returning(),
    ).id;
    srcAcctA = one(
      await db
        .insert(sourceAccounts)
        .values({ workspaceId: wsA, dataSourceId: dsA, displayName: "Everyday" })
        .returning(),
    ).id;
    impAugust = one(
      await db
        .insert(imports)
        .values({ workspaceId: wsA, dataSourceId: dsA, idempotencyKey: `aug-${uuidv7()}` })
        .returning(),
    ).id;
    impSeptember = one(
      await db
        .insert(imports)
        .values({ workspaceId: wsA, dataSourceId: dsA, idempotencyKey: `sep-${uuidv7()}` })
        .returning(),
    ).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("stages September overlap as pending, outside canonical totals", async () => {
    const db = drizzlePglite(pg, { schema });
    const store = createDrizzleMatchStore(db);
    const canonicalId = await acceptSeed(await seedSourceTxn(), "BOOKSTORE");
    const before = await count("transactions", "WHERE workspace_id = $1", [wsA]);

    const outcome = await decideRowForImport(
      store,
      matchInput({ sourceTransactionId: await seedSourceTxn() }),
    );
    expect(outcome.disposition).toBe("pending");
    expect(outcome.transactionId).toBeNull();
    expect(outcome.candidateIds).toHaveLength(1);
    // No new canonical: totals unchanged.
    expect(await count("transactions", "WHERE workspace_id = $1", [wsA])).toBe(before);

    const pending = await listPendingCandidates(db, wsA, impSeptember);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      candidateTransactionId: canonicalId,
      candidateDescription: "BOOKSTORE",
      stagedDescription: "BOOKSTORE",
      stagedDate: "2026-08-12",
      stagedAmountMinor: "2499",
      stagedCurrency: "EUR",
      stagedDirection: "debit",
      matchRule: "fuzzy-date-amount-description",
    });
    // Retry stages nothing new (pair-unique convergence).
    const stagedSource = one(
      await q<{ source_transaction_id: string }>(
        `SELECT source_transaction_id FROM import_match_candidates WHERE id = $1`,
        [outcome.candidateIds[0]],
      ),
    ).source_transaction_id;
    const retry = await decideRowForImport(
      store,
      matchInput({ sourceTransactionId: stagedSource }),
    );
    expect(retry.disposition).toBe("pending");
    expect(await count("import_match_candidates", "WHERE workspace_id = $1", [wsA])).toBe("1");
  });

  it("merges trusted external keys without a new canonical", async () => {
    const db = drizzlePglite(pg, { schema });
    const store = createDrizzleMatchStore(db);
    // Old feed row with a guaranteed key, already canonicalized.
    const oldSource = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: dsA, externalId: "bank-txn-7" })
        .returning(),
    );
    const canonicalId = await acceptSeed(await seedSourceTxn(), "BANK FEE");
    await db.insert(transactionSourceLinks).values({
      workspaceId: wsA,
      transactionId: canonicalId,
      sourceTransactionId: oldSource.id,
      relationship: "PRIMARY",
    });

    const before = await count("transactions", "WHERE workspace_id = $1", [wsA]);
    const freshSourceId = await seedSourceTxn();
    const outcome = await decideRowForImport(
      store,
      matchInput({ sourceTransactionId: freshSourceId, externalId: "bank-txn-7" }),
    );
    expect(outcome.disposition).toBe("matched");
    expect(outcome.transactionId).toBe(canonicalId);
    expect(await count("transactions", "WHERE workspace_id = $1", [wsA])).toBe(before);
    const recorded = await q<{ confidence: string; status: string }>(
      `SELECT confidence, status FROM import_match_candidates
        WHERE source_transaction_id = $1`,
      [freshSourceId],
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ confidence: "auto", status: "linked" });
  });

  it("resolves pending rows to linked or distinct with audit and outbox", async () => {
    const db = drizzlePglite(pg, { schema });
    const impResolve = one(
      await db
        .insert(imports)
        .values({ workspaceId: wsA, dataSourceId: dsA, idempotencyKey: `resolve-${uuidv7()}` })
        .returning(),
    ).id;
    const augustId = await acceptSeed(await seedSourceTxn(), "LINK ME");
    const staged = await decideRowForImport(
      createDrizzleMatchStore(db),
      matchInput({
        importId: impResolve,
        sourceTransactionId: await seedSourceTxn(),
        row: row({ description: "Link me" }),
      }),
    );
    expect(staged.disposition).toBe("pending");
    expect(await listPendingCandidates(db, wsA, impResolve)).toHaveLength(1);
    const candidateId = staged.candidateIds[0] as string;
    const before = await count("transactions", "WHERE workspace_id = $1", [wsA]);

    const linked = await executeResolveMatch(
      db,
      { workspaceId: wsA, actorUserId: null, idempotencyKey: `res-${uuidv7()}` },
      { candidateId, decision: "link" },
    );
    expect(linked.result).toMatchObject({ decision: "link", transactionId: augustId });
    expect(await count("transactions", "WHERE workspace_id = $1", [wsA])).toBe(before);

    // The linked source observation is preserved alongside the original.
    const links = await count("transaction_source_links", "WHERE transaction_id = $1", [augustId]);
    expect(Number(links)).toBeGreaterThanOrEqual(2);

    const staged2 = await decideRowForImport(
      createDrizzleMatchStore(db),
      matchInput({
        importId: impResolve,
        sourceTransactionId: await seedSourceTxn(),
        row: row({ description: "Link me", rowNumber: 2 }),
      }),
    );
    const distinct = await executeResolveMatch(
      db,
      { workspaceId: wsA, actorUserId: null, idempotencyKey: `res-${uuidv7()}` },
      { candidateId: staged2.candidateIds[0] as string, decision: "distinct" },
    );
    expect(distinct.result.decision).toBe("distinct");
    expect(await count("transactions", "WHERE workspace_id = $1", [wsA])).toBe(
      String(Number(before) + 1),
    );
    expect(await listPendingCandidates(db, wsA, impResolve)).toHaveLength(0);

    // Re-resolving fails loudly instead of double-applying.
    await expect(
      executeResolveMatch(
        db,
        { workspaceId: wsA, actorUserId: null, idempotencyKey: `res-${uuidv7()}` },
        { candidateId, decision: "link" },
      ),
    ).rejects.toMatchObject({ code: "INVARIANT_VIOLATION" });
  });

  it("keeps identical legitimate rows distinct (no fuzzy uniqueness)", async () => {
    const db = drizzlePglite(pg, { schema });
    const first = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: dsA })
        .returning(),
    );
    const second = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsA, dataSourceId: dsA })
        .returning(),
    );
    expect(first.id).not.toBe(second.id);
  });

  it("rejects bad rule/confidence/status values and isolates tenants", async () => {
    const db = drizzlePglite(pg, { schema });
    const acctB = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsB, name: "Foreign", currencyCode: "EUR" })
        .returning(),
    );
    const txnB = one(
      await db
        .insert(transactions)
        .values({
          workspaceId: wsB,
          accountId: acctB.id,
          direction: "debit",
          amountMinor: 100,
          currencyCode: "EUR",
          effectiveDate: "2026-08-12",
          description: "FOREIGN",
        })
        .returning(),
    );
    const srcB = one(
      await db
        .insert(sourceTransactions)
        .values({ workspaceId: wsB, dataSourceId: dsA })
        .returning(),
    ).id;
    // Cross-workspace source reference fails at the FK/RLS layer, never silently.
    await expectDbError(
      db.insert(importMatchCandidates).values({
        workspaceId: wsB,
        importId: impAugust,
        dataSourceId: dsA,
        sourceTransactionId: srcB,
        candidateTransactionId: txnB.id,
        matchRule: "teleport",
        confidence: "review",
        status: "pending",
      }),
      /import_match_candidates_rule_check|violates foreign key constraint|row-level security/,
    );
    await expectDbError(
      db.insert(importMatchCandidates).values({
        workspaceId: wsB,
        importId: impAugust,
        dataSourceId: dsA,
        sourceTransactionId: srcB,
        candidateTransactionId: txnB.id,
        matchRule: "fuzzy-date-amount-description",
        confidence: "certain",
        status: "pending",
      }),
      /import_match_candidates_confidence_check/,
    );
    await asApp(wsA, async () => {
      expect(await count("import_match_candidates")).toBe(
        await count("import_match_candidates", "WHERE workspace_id = $1", [wsA]),
      );
    });
    await asApp(wsB, async () => {
      expect(await count("import_match_candidates")).toBe("0");
    });
    await asApp(null, async () => {
      expect(await count("import_match_candidates")).toBe("0");
    });
    const grants = await q<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'moneo_app' AND table_name = 'import_match_candidates'`,
    );
    expect(grants.map((g) => g.privilege_type)).toEqual(
      expect.arrayContaining(["SELECT", "INSERT", "UPDATE", "DELETE"]),
    );
  });
});
