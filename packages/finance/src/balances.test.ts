import { describe, expect, it } from "vitest";
import { DomainError } from "@moneo/shared/problem";
import {
  balanceStateFor,
  createRecordBalanceCommand,
  previewReconciliation,
  type BalanceSnapshotLike,
  type RecordBalanceData,
  type RecordBalanceInput,
} from "./balances.js";
import { CommandError, createMemoryCommandStore, executeCommand } from "./commands.js";

/**
 * Issue 4.10 — reconciliation math, coverage states, and the recordBalance
 * command lifecycle (memory store: no I/O).
 *
 * Proves: roll-forward applies on/after-cutoff rows once with exact signs;
 * earlier rows never apply; cross-currency rows mark unresolved instead of
 * silently dropping; unknown inclusion/amounts stay unresolved; coverage
 * states distinguish unknown/ok/unreconciled/conflict; the command
 * converges retries onto one snapshot, audits, emits the outbox event, and
 * refuses foreign accounts without disclosing them.
 */

function snapshot(overrides: Partial<BalanceSnapshotLike> = {}): BalanceSnapshotLike {
  return {
    observedAt: "2026-08-15T12:00:00Z",
    currentAmountMinor: "10000",
    availableAmountMinor: null,
    currencyCode: "EUR",
    source: "manual",
    cutoffDate: "2026-08-15",
    ...overrides,
  };
}

function txn(
  id: string,
  effectiveDate: string,
  direction: "credit" | "debit",
  amountMinor: string,
  currencyCode = "EUR",
) {
  return { id, effectiveDate, direction, amountMinor, currencyCode };
}

describe("previewReconciliation", () => {
  it("rolls forward on/after-cutoff rows once with exact signs", () => {
    const preview = previewReconciliation(snapshot(), [
      txn("t1", "2026-08-14", "debit", "100"),
      txn("t2", "2026-08-15", "debit", "1550"),
      txn("t3", "2026-08-16", "credit", "200000"),
    ]);
    // 10000 − 1550 + 200000 = 208450; the Aug-14 row was already included.
    expect(preview).toEqual({
      applicableCount: 2,
      skippedCrossCurrency: 0,
      projectedCurrentMinor: "208450",
      unresolved: false,
      reason: null,
      truncated: false,
    });
  });

  it("projects negative (overdrawn) snapshots forward", () => {
    const preview = previewReconciliation(snapshot({ currentAmountMinor: "-500" }), [
      txn("t1", "2026-08-16", "credit", "1000"),
    ]);
    expect(preview.projectedCurrentMinor).toBe("500");
    expect(preview.unresolved).toBe(false);
  });

  it("marks cross-currency rows unresolved instead of skipping them", () => {
    const preview = previewReconciliation(snapshot(), [
      txn("t1", "2026-08-16", "debit", "1500", "JPY"),
    ]);
    expect(preview.unresolved).toBe(true);
    expect(preview.reason).toBe("mixed-currency");
    expect(preview.projectedCurrentMinor).toBeNull();
    expect(preview.skippedCrossCurrency).toBe(1);
  });

  it("stays unresolved without a cutoff, an amount, or a snapshot", () => {
    expect(previewReconciliation(snapshot({ cutoffDate: null }), []).reason).toBe("no-cutoff");
    expect(previewReconciliation(snapshot({ currentAmountMinor: null }), []).reason).toBe(
      "no-snapshot-amount",
    );
    expect(previewReconciliation(null, []).reason).toBe("no-snapshot-amount");
    expect(previewReconciliation(snapshot(), [], { truncated: true }).reason).toBe("truncated");
  });
});

describe("balanceStateFor", () => {
  it("distinguishes unknown, ok, unreconciled, and conflict", () => {
    expect(balanceStateFor([])).toBe("unknown");
    expect(balanceStateFor([snapshot()])).toBe("ok");
    expect(balanceStateFor([snapshot({ cutoffDate: null })])).toBe("unreconciled");
    expect(
      balanceStateFor([
        snapshot({ currentAmountMinor: "10000" }),
        snapshot({ currentAmountMinor: "9999" }),
      ]),
    ).toBe("conflict");
    // An older snapshot never conflicts with its superseder.
    expect(
      balanceStateFor([
        snapshot({ observedAt: "2026-08-01T00:00:00Z", currentAmountMinor: "1" }),
        snapshot(),
      ]),
    ).toBe("ok");
  });
});

function memoryData(): RecordBalanceData & { snapshots: RecordBalanceInput[] } {
  const snapshots: RecordBalanceInput[] = [];
  return {
    snapshots,
    findAccount: (_wid, accountId) =>
      Promise.resolve(accountId === "acct-1" ? { id: "acct-1", currencyCode: "EUR" } : null),
    latestExists: () => Promise.resolve(snapshots.length > 0),
    findDuplicate: (_wid, input) =>
      Promise.resolve(
        snapshots.find(
          (s) =>
            s.accountId === input.accountId &&
            s.observedAt === input.observedAt &&
            (s.currentAmountMinor ?? null) === (input.currentAmountMinor ?? null) &&
            s.cutoffDate === input.cutoffDate &&
            s.source === input.source,
        )
          ? { id: "snap-dupe" }
          : null,
      ),
    insertSnapshot: (_wid, input) => {
      snapshots.push(input);
      return Promise.resolve({ id: `snap-${snapshots.length}` });
    },
  };
}

function validInput(overrides: Partial<RecordBalanceInput> = {}): RecordBalanceInput {
  return {
    accountId: "acct-1",
    observedAt: "2026-08-15T12:00:00Z",
    currentAmountMinor: "10000",
    availableAmountMinor: null,
    currencyCode: "EUR",
    source: "manual",
    cutoffDate: "2026-08-15",
    ...overrides,
  };
}

describe("createRecordBalanceCommand", () => {
  it("records, supersedes, and converges retries onto one snapshot", async () => {
    const data = memoryData();
    const command = createRecordBalanceCommand(data);
    const store = createMemoryCommandStore();
    const ctx = { workspaceId: "ws-1", actorUserId: null, idempotencyKey: "k-1" };

    const first = await executeCommand(command, ctx, validInput(), store);
    expect(first.result).toMatchObject({
      snapshotId: "snap-1",
      superseded: false,
      duplicate: false,
    });
    expect(first.replayed).toBe(false);

    const replay = await executeCommand(command, ctx, validInput(), store);
    expect(replay.result).toMatchObject({ snapshotId: "snap-1", duplicate: false });
    expect(replay.replayed).toBe(true);
    expect(data.snapshots).toHaveLength(1);

    // A distinct entry supersedes the first.
    const second = await executeCommand(
      command,
      { ...ctx, idempotencyKey: "k-2" },
      validInput({ observedAt: "2026-08-20T12:00:00Z", currentAmountMinor: "9000" }),
      store,
    );
    expect(second.result).toMatchObject({ snapshotId: "snap-2", superseded: true });
    // Same data under a fresh key converges onto the existing row (no double-apply).
    const dupe = await executeCommand(
      command,
      { ...ctx, idempotencyKey: "k-3" },
      validInput(),
      store,
    );
    expect(dupe.result).toMatchObject({ snapshotId: "snap-dupe", duplicate: true });
    expect(data.snapshots).toHaveLength(2);
    // Three audits: two inserts plus the convergence trail.
    expect(store.audit()).toHaveLength(3);
    expect(store.outbox()[0]).toMatchObject({
      aggregateType: "account",
      eventType: "account.balanceRecorded",
    });
  });

  it("refuses foreign accounts without disclosing them", async () => {
    const command = createRecordBalanceCommand(memoryData());
    await expect(
      executeCommand(
        command,
        { workspaceId: "ws-1", actorUserId: null, idempotencyKey: "k-x" },
        validInput({ accountId: "acct-other-workspace" }),
        createMemoryCommandStore(),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      executeCommand(
        command,
        { workspaceId: "ws-1", actorUserId: null, idempotencyKey: "k-y" },
        validInput({ currencyCode: "JPY" }),
        createMemoryCommandStore(),
      ),
    ).rejects.toBeInstanceOf(CommandError);
  });

  it("rejects malformed money and dates as domain errors", async () => {
    const command = createRecordBalanceCommand(memoryData());
    for (const bad of [
      validInput({ currentAmountMinor: "10.00" }),
      validInput({ cutoffDate: "15.08.2026" }),
      validInput({ observedAt: "not-a-date" }),
    ]) {
      await expect(
        executeCommand(
          command,
          { workspaceId: "ws-1", actorUserId: null, idempotencyKey: `k-${Math.random()}` },
          bad,
          createMemoryCommandStore(),
        ),
      ).rejects.toBeInstanceOf(DomainError);
    }
  });
});
