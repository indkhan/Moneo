import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import {
  balanceStateFor,
  createRecordBalanceCommand,
  executeCommand,
  type BalanceSnapshotLike,
  type BalanceState,
  type CommandContext,
  type CommandOutcome,
  type RecordBalanceData,
  type RecordBalanceInput,
  type RecordBalanceResult,
} from "@moneo/finance";
import { createDrizzleCommandStore, type CommandStoreDb } from "./command-store.js";
import { accountBalanceSnapshots, accounts } from "./schema.js";

/**
 * Issue 4.10 — Drizzle wiring for `accounts.recordBalance`.
 *
 * Runs inside the caller's `withWorkspaceTransaction`: the duplicate check,
 * the insert, the audit row, and the outbox event commit atomically, so a
 * retried HTTP submission converges onto one snapshot instead of
 * double-applying. Observed-at matching is exact (ISO millis round-trip
 * through timestamptz); anything else is a new snapshot, never an update.
 */

function dataOver(db: CommandStoreDb): RecordBalanceData {
  return {
    async findAccount(workspaceId, accountId) {
      const rows = await db
        .select({ id: accounts.id, currencyCode: accounts.currencyCode })
        .from(accounts)
        .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)))
        .limit(1);
      return rows[0] ?? null;
    },
    async latestExists(workspaceId, accountId) {
      const rows = await db
        .select({ id: accountBalanceSnapshots.id })
        .from(accountBalanceSnapshots)
        .where(
          and(
            eq(accountBalanceSnapshots.workspaceId, workspaceId),
            eq(accountBalanceSnapshots.accountId, accountId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async findDuplicate(workspaceId, input) {
      const current = input.currentAmountMinor === null ? null : Number(input.currentAmountMinor);
      const available =
        input.availableAmountMinor === null || input.availableAmountMinor === undefined
          ? null
          : Number(input.availableAmountMinor);
      // NULL never equals NULL in SQL: unknown amounts match only unknown.
      const conditions: SQL[] = [
        eq(accountBalanceSnapshots.workspaceId, workspaceId),
        eq(accountBalanceSnapshots.accountId, input.accountId),
        eq(accountBalanceSnapshots.observedAt, new Date(input.observedAt)),
        current === null
          ? isNull(accountBalanceSnapshots.currentAmountMinor)
          : eq(accountBalanceSnapshots.currentAmountMinor, current),
        available === null
          ? isNull(accountBalanceSnapshots.availableAmountMinor)
          : eq(accountBalanceSnapshots.availableAmountMinor, available),
        eq(accountBalanceSnapshots.source, input.source),
        input.cutoffDate === null
          ? isNull(accountBalanceSnapshots.cutoffDate)
          : eq(accountBalanceSnapshots.cutoffDate, input.cutoffDate),
      ];
      const rows = await db
        .select({ id: accountBalanceSnapshots.id })
        .from(accountBalanceSnapshots)
        .where(and(...conditions))
        .limit(1);
      return rows[0] ?? null;
    },
    async insertSnapshot(workspaceId, input) {
      const rows = await db
        .insert(accountBalanceSnapshots)
        .values({
          workspaceId,
          accountId: input.accountId,
          observedAt: new Date(input.observedAt),
          currentAmountMinor:
            input.currentAmountMinor === null ? null : Number(input.currentAmountMinor),
          availableAmountMinor:
            input.availableAmountMinor === null || input.availableAmountMinor === undefined
              ? null
              : Number(input.availableAmountMinor),
          currencyCode: input.currencyCode.toUpperCase(),
          source: input.source,
          cutoffDate: input.cutoffDate,
          sourceImportId: input.sourceImportId ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error("Snapshot insert returned no row.");
      }
      return { id: row.id };
    },
  };
}

export async function executeRecordBalance(
  db: CommandStoreDb,
  ctx: CommandContext,
  input: RecordBalanceInput,
): Promise<CommandOutcome<RecordBalanceResult>> {
  return executeCommand(
    createRecordBalanceCommand(dataOver(db)),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}

/** Newest snapshot first (observed_at DESC, id DESC): the supersede order. */
export async function listBalanceSnapshots(
  db: CommandStoreDb,
  workspaceId: string,
  accountId: string,
) {
  return db
    .select()
    .from(accountBalanceSnapshots)
    .where(
      and(
        eq(accountBalanceSnapshots.workspaceId, workspaceId),
        eq(accountBalanceSnapshots.accountId, accountId),
      ),
    )
    .orderBy(desc(accountBalanceSnapshots.observedAt), desc(accountBalanceSnapshots.id));
}

/**
 * Coverage state per account for Markets/aggregates/forecast gates: unknown
 * means no snapshot (never zero), conflict needs a superseding entry, and
 * unreconciled needs an explicit cutoff. E10 refuses actionable
 * Available-to-Spend while required accounts are not `ok`.
 */
export async function getBalanceStates(
  db: CommandStoreDb,
  workspaceId: string,
  accountIds: readonly string[],
): Promise<Map<string, BalanceState>> {
  const result = new Map<string, BalanceState>();
  const unique = [...new Set(accountIds)];
  for (const id of unique) {
    result.set(id, "unknown");
  }
  if (unique.length === 0) {
    return result;
  }
  const rows = await db
    .select()
    .from(accountBalanceSnapshots)
    .where(
      and(
        eq(accountBalanceSnapshots.workspaceId, workspaceId),
        inArray(accountBalanceSnapshots.accountId, unique),
      ),
    );
  const byAccount = new Map<string, BalanceSnapshotLike[]>();
  for (const row of rows) {
    const list = byAccount.get(row.accountId) ?? [];
    list.push({
      observedAt: row.observedAt.toISOString(),
      currentAmountMinor: row.currentAmountMinor === null ? null : String(row.currentAmountMinor),
      availableAmountMinor:
        row.availableAmountMinor === null ? null : String(row.availableAmountMinor),
      currencyCode: row.currencyCode,
      source: row.source as BalanceSnapshotLike["source"],
      cutoffDate: row.cutoffDate,
    });
    byAccount.set(row.accountId, list);
  }
  for (const [accountId, snapshots] of byAccount) {
    result.set(accountId, balanceStateFor(snapshots));
  }
  return result;
}
