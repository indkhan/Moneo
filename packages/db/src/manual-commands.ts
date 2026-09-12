import { and, desc, eq } from "drizzle-orm";
import {
  createManualAccountCommand,
  createManualTransactionCommand,
  executeCommand,
  type CommandContext,
  type CommandOutcome,
  type CreateManualAccountInput,
  type CreateManualAccountResult,
  type CreateManualTransactionInput,
  type CreateManualTransactionResult,
  type ManualAccountData,
  type ManualTransactionData,
} from "@moneo/finance";
import { createDrizzleCommandStore, type CommandStoreDb } from "./command-store.js";
import { accountBalanceSnapshots, accounts, transactions } from "./schema.js";

/**
 * Issue 4.12 — Drizzle wiring for manual commands.
 *
 * Manual rows carry user/command provenance through audit events only: no
 * source rows are fabricated, so the detail drawer honestly reports
 * "Manually recorded". Both executors run inside the caller's
 * `withWorkspaceTransaction`, and idempotency keys make retries converge.
 */

function accountDataOver(db: CommandStoreDb): ManualAccountData {
  return {
    async insertAccount(workspaceId, input) {
      const rows = await db
        .insert(accounts)
        .values({
          workspaceId,
          name: input.name,
          currencyCode: input.currencyCode,
          accountType: input.accountType ?? "OTHER",
          institutionName: input.institutionName ?? null,
          isSpendable: input.isSpendable ?? true,
          includeInNetWorth: input.includeInNetWorth ?? true,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error("Account insert returned no row.");
      }
      return { id: row.id };
    },
  };
}

function transactionDataOver(db: CommandStoreDb): ManualTransactionData {
  return {
    async findAccount(workspaceId, accountId) {
      const rows = await db
        .select({ id: accounts.id, currencyCode: accounts.currencyCode })
        .from(accounts)
        .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)))
        .limit(1);
      return rows[0] ?? null;
    },
    async latestCutoff(workspaceId, accountId) {
      const rows = await db
        .select({
          cutoffDate: accountBalanceSnapshots.cutoffDate,
          currencyCode: accountBalanceSnapshots.currencyCode,
        })
        .from(accountBalanceSnapshots)
        .where(
          and(
            eq(accountBalanceSnapshots.workspaceId, workspaceId),
            eq(accountBalanceSnapshots.accountId, accountId),
          ),
        )
        .orderBy(desc(accountBalanceSnapshots.observedAt), desc(accountBalanceSnapshots.id))
        .limit(1);
      const row = rows[0];
      return row ? { cutoffDate: row.cutoffDate, currencyCode: row.currencyCode } : null;
    },
    async insertTransaction(workspaceId, input) {
      const rows = await db
        .insert(transactions)
        .values({
          workspaceId,
          accountId: input.accountId,
          status: "POSTED",
          direction: input.direction,
          amountMinor: Number(input.amountMinor),
          currencyCode: input.currencyCode,
          effectiveDate: input.effectiveDate,
          description: input.description,
          note: input.note,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error("Transaction insert returned no row.");
      }
      return { id: row.id };
    },
  };
}

export async function executeCreateManualAccount(
  db: CommandStoreDb,
  ctx: CommandContext,
  input: CreateManualAccountInput,
): Promise<CommandOutcome<CreateManualAccountResult>> {
  return executeCommand(
    createManualAccountCommand(accountDataOver(db)),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}

export async function executeCreateManualTransaction(
  db: CommandStoreDb,
  ctx: CommandContext,
  input: CreateManualTransactionInput,
): Promise<CommandOutcome<CreateManualTransactionResult>> {
  return executeCommand(
    createManualTransactionCommand(transactionDataOver(db)),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}
