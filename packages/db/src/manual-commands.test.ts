import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import {
  auditEvents,
  outboxEvents,
  sourceTransactionObservations,
  transactions,
  workspaces,
} from "./schema.js";
import { executeCreateManualAccount, executeCreateManualTransaction } from "./manual-commands.js";
import { executeRecordBalance } from "./balance-commands.js";
import { getAccountBalances } from "./account-queries.js";
import { createMigratedDb, one } from "./pglite-test-db.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 4.12 — manual commands over Drizzle (full chain).
 *
 * Proves the acceptance: a cash wallet plus a €15 purchase records through
 * audited commands; retrying yields one transaction; unauthorized account
 * selection fails closed; future rows move the projection while older rows
 * stay history-only; balances read back consistently; and manual rows never
 * fabricate source observations.
 */
describe("manual accounts and cash transactions (issue 4.12)", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;

  beforeAll(async () => {
    pg = await createMigratedDb("0013_import_matching");
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Manual A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Manual B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  const ctxFor = (workspaceId: string, key: string) => ({
    workspaceId,
    actorUserId: null,
    idempotencyKey: key,
  });

  it("creates a cash wallet and records a €15 purchase", async () => {
    const db = drizzlePglite(pg, { schema });
    const wallet = await executeCreateManualAccount(db, ctxFor(wsA, `m-${uuidv7()}`), {
      name: "Cash wallet",
      currencyCode: "EUR",
      accountType: "CASH",
    });
    const walletId = wallet.result.accountId;
    expect(walletId).toEqual(expect.any(String));

    const purchaseKey = `m-${uuidv7()}`;
    const purchase = await executeCreateManualTransaction(db, ctxFor(wsA, purchaseKey), {
      accountId: walletId,
      effectiveDate: "2026-08-16",
      description: "Cash coffee",
      amountMinor: "1500",
      currencyCode: "EUR",
      direction: "debit",
    });
    expect(purchase.result).toMatchObject({ accountId: walletId, affectsProjection: false });

    // Retry: one transaction, identical result.
    const replay = await executeCreateManualTransaction(db, ctxFor(wsA, purchaseKey), {
      accountId: walletId,
      effectiveDate: "2026-08-16",
      description: "Cash coffee",
      amountMinor: "1500",
      currencyCode: "EUR",
      direction: "debit",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.result.transactionId).toBe(purchase.result.transactionId);
    const rows = await db.select().from(transactions);
    expect(rows.filter((r) => r.description === "Cash coffee")).toHaveLength(1);

    // Audit + outbox landed for both commands.
    const audits = await db.select().from(auditEvents);
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["accounts.createManual", "transactions.createManual"]),
    );
    const outbox = await db.select().from(outboxEvents);
    expect(outbox.map((o) => o.eventType)).toEqual(
      expect.arrayContaining(["account.created", "transaction.created"]),
    );

    // Manual provenance only: no source observation was fabricated.
    expect(await db.select().from(sourceTransactionObservations)).toHaveLength(0);
  });

  it("fails closed for unauthorized accounts", async () => {
    const db = drizzlePglite(pg, { schema });
    const foreign = await executeCreateManualAccount(db, ctxFor(wsB, `m-${uuidv7()}`), {
      name: "Foreign",
      currencyCode: "EUR",
    });
    await expect(
      executeCreateManualTransaction(db, ctxFor(wsA, `m-${uuidv7()}`), {
        accountId: foreign.result.accountId,
        effectiveDate: "2026-08-16",
        description: "Hijack",
        amountMinor: "100",
        currencyCode: "EUR",
        direction: "debit",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("respects snapshot cutoffs for future and older rows", async () => {
    const db = drizzlePglite(pg, { schema });
    const walletId = (
      await executeCreateManualAccount(db, ctxFor(wsA, `m-${uuidv7()}`), {
        name: "Cutoff wallet",
        currencyCode: "EUR",
      })
    ).result.accountId;
    await executeRecordBalance(db, ctxFor(wsA, `m-${uuidv7()}`), {
      accountId: walletId,
      observedAt: "2026-08-15T12:00:00Z",
      currentAmountMinor: "10000",
      availableAmountMinor: null,
      currencyCode: "EUR",
      source: "manual",
      cutoffDate: "2026-08-15",
    });

    const future = await executeCreateManualTransaction(db, ctxFor(wsA, `m-${uuidv7()}`), {
      accountId: walletId,
      effectiveDate: "2026-08-20",
      description: "Future groceries",
      amountMinor: "2000",
      currencyCode: "EUR",
      direction: "debit",
    });
    expect(future.result.affectsProjection).toBe(true);

    const older = await executeCreateManualTransaction(db, ctxFor(wsA, `m-${uuidv7()}`), {
      accountId: walletId,
      effectiveDate: "2026-08-10",
      description: "Older top-up",
      amountMinor: "5000",
      currencyCode: "EUR",
      direction: "credit",
    });
    // Already inside the recorded balance: history only, never double-applied.
    expect(older.result.affectsProjection).toBe(false);

    const balances = await getAccountBalances(db, wsA, [walletId]);
    expect(balances.get(walletId)?.currentAmountMinor).toBe("10000");
  });
});
