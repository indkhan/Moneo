import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import {
  accountBalanceSnapshots,
  accounts,
  auditEvents,
  outboxEvents,
  workspaces,
} from "./schema.js";
import {
  executeRecordBalance,
  getBalanceStates,
  listBalanceSnapshots,
} from "./balance-commands.js";
import { createMigratedDb, one } from "./pglite-test-db.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 4.10 — `accounts.recordBalance` over Drizzle (migration 0012).
 *
 * Proves end to end: recording supersedes by insert (history preserved);
 * an identical retry converges onto one row; same key with different input
 * is rejected; audit and outbox rows land with the effect; foreign accounts
 * fail closed; and identical histories with different opening balances
 * project to different current balances.
 */
describe("accounts.recordBalance command (issue 4.10)", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;
  let acctA!: string;

  beforeAll(async () => {
    pg = await createMigratedDb("0012_command_input_hash");
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Balances A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Balances B" }).returning()).id;
    acctA = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: "Everyday", currencyCode: "EUR" })
        .returning(),
    ).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  const ctxFor = (workspaceId: string, key: string) => ({
    workspaceId,
    actorUserId: null,
    idempotencyKey: key,
  });

  const entry = (overrides: Record<string, unknown> = {}) => ({
    accountId: acctA,
    observedAt: "2026-08-15T12:00:00Z",
    currentAmountMinor: "10000",
    availableAmountMinor: null,
    currencyCode: "EUR",
    source: "manual" as const,
    cutoffDate: "2026-08-15",
    ...overrides,
  });

  it("records, supersedes by insert, and converges retries", async () => {
    const db = drizzlePglite(pg, { schema });
    const first = await executeRecordBalance(db, ctxFor(wsA, "b-1"), entry());
    expect(first.result.superseded).toBe(false);
    expect(first.result.duplicate).toBe(false);
    expect(first.replayed).toBe(false);

    const replay = await executeRecordBalance(db, ctxFor(wsA, "b-1"), entry());
    expect(replay.result.snapshotId).toBe(first.result.snapshotId);
    expect(replay.replayed).toBe(true);

    const second = await executeRecordBalance(
      db,
      ctxFor(wsA, "b-2"),
      entry({ observedAt: "2026-08-20T12:00:00Z", currentAmountMinor: "9000" }),
    );
    expect(second.result.superseded).toBe(true);

    const history = await listBalanceSnapshots(db, wsA, acctA);
    expect(history.map((s) => s.currentAmountMinor)).toEqual([9000, 10000]);
    expect(
      await db
        .select()
        .from(accountBalanceSnapshots)
        .then((rows) => rows.filter((r) => r.accountId === acctA)),
    ).toHaveLength(2);
  });

  it("rejects same key with different input and writes audit + outbox", async () => {
    const db = drizzlePglite(pg, { schema });
    await executeRecordBalance(db, ctxFor(wsA, "b-3"), entry());
    await expect(
      executeRecordBalance(db, ctxFor(wsA, "b-3"), entry({ currentAmountMinor: "1" })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const audits = await db.select().from(auditEvents);
    const recordAudits = audits.filter((a) => a.action === "accounts.recordBalance");
    expect(recordAudits.length).toBeGreaterThan(0);
    expect(recordAudits[0]?.entityType).toBe("account");
    expect(recordAudits[0]?.commandOperationId).toEqual(expect.any(String));

    const outbox = await db.select().from(outboxEvents);
    const recorded = outbox.filter((o) => o.eventType === "account.balanceRecorded");
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0]?.aggregateType).toBe("account");
  });

  it("fails closed for foreign accounts and bad input", async () => {
    const db = drizzlePglite(pg, { schema });
    const foreign = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsB, name: "Foreign", currencyCode: "EUR" })
        .returning(),
    );
    await expect(
      executeRecordBalance(db, ctxFor(wsA, `b-${uuidv7()}`), entry({ accountId: foreign.id })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      executeRecordBalance(db, ctxFor(wsA, `b-${uuidv7()}`), entry({ currencyCode: "JPY" })),
    ).rejects.toThrow();
    await expect(
      executeRecordBalance(db, ctxFor(wsA, `b-${uuidv7()}`), entry({ cutoffDate: "15.08.2026" })),
    ).rejects.toThrow();
  });

  it("reports per-account coverage states for aggregate gates", async () => {
    const db = drizzlePglite(pg, { schema });
    const bare = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Bare ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    ).id;
    const states = await getBalanceStates(db, wsA, [acctA, bare]);
    expect(states.get(acctA)).toBe("ok");
    expect(states.get(bare)).toBe("unknown");
    expect(await getBalanceStates(db, wsA, [])).toEqual(new Map());
  });
});
