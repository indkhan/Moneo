import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import {
  operationIdFor,
  type CommandAuditRecord,
  type CommandOutboxRecord,
  type CommandStore,
  type StoredClaim,
} from "@moneo/finance";
import type { Db } from "./client.js";
import { auditEvents, commandOperations, outboxEvents } from "./schema.js";
import type * as schema from "./schema.js";

/**
 * Issue 4.10 — Drizzle-backed command store (the Epoch 4+ piece Issue 2.2
 * foresaw, over the Issue 2.1 tables).
 *
 * The caller runs everything inside ONE `withWorkspaceTransaction`: claim
 * insert, business mutation, and `commitSuccess` share the transaction, so
 * an effect can never exist without its audit/outbox rows (and vice
 * versa). The UNIQUE(workspace_id, command_name, idempotency_key) insert
 * IS the claim — a retried key reads the stored result instead of
 * re-mutating. Honest limitation, documented: the claim serializes
 * sequential retries (the at-least-once case); exact-concurrent
 * same-key submissions additionally rely on each command's own
 * business-level idempotency (recordBalance duplicate-checks in loadState).
 *
 * Command results are objects by construction (never bare scalars), so no
 * wrapping marker is needed — replays return the stored JSON verbatim.
 */

export type CommandStoreDb = Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

function keyOf(workspaceId: string, commandName: string, idempotencyKey: string) {
  return and(
    eq(commandOperations.workspaceId, workspaceId),
    eq(commandOperations.commandName, commandName),
    eq(commandOperations.idempotencyKey, idempotencyKey),
  );
}

function toStoredClaim(row: typeof commandOperations.$inferSelect): StoredClaim {
  return {
    status: row.status as StoredClaim["status"],
    inputHash: row.inputHash,
    result: row.result,
    resultingVersion: row.resultingVersion,
  };
}

export function createDrizzleCommandStore(db: CommandStoreDb): CommandStore {
  return {
    async withClaim<R>(
      workspaceId: string,
      commandName: string,
      idempotencyKey: string,
      inputHash: string,
      fn: (existing: StoredClaim | null) => Promise<R>,
    ): Promise<R> {
      const inserted = await db
        .insert(commandOperations)
        .values({ workspaceId, commandName, idempotencyKey, inputHash, status: "claimed" })
        .onConflictDoNothing({
          target: [
            commandOperations.workspaceId,
            commandOperations.commandName,
            commandOperations.idempotencyKey,
          ],
        })
        .returning();
      if (inserted.length > 0) {
        return fn(null);
      }
      return fn(await this.readClaim(workspaceId, commandName, idempotencyKey));
    },

    async readClaim(
      workspaceId: string,
      commandName: string,
      idempotencyKey: string,
    ): Promise<StoredClaim | null> {
      const rows = await db
        .select()
        .from(commandOperations)
        .where(keyOf(workspaceId, commandName, idempotencyKey))
        .limit(1);
      const row = rows[0];
      return row ? toStoredClaim(row) : null;
    },

    async commitSuccess(
      workspaceId: string,
      commandName: string,
      idempotencyKey: string,
      commit: {
        actorUserId: string | null;
        resultingVersion: number | null;
        result: unknown;
        audit: CommandAuditRecord & { commandOperationId: string };
        outbox: CommandOutboxRecord[];
      },
    ): Promise<string> {
      const operationId = operationIdFor(workspaceId, commandName, idempotencyKey);
      const claimRows = await db
        .select({ id: commandOperations.id })
        .from(commandOperations)
        .where(keyOf(workspaceId, commandName, idempotencyKey))
        .limit(1);
      const claim = claimRows[0];
      if (!claim) {
        throw new Error(`commitSuccess without claim for ${operationId}`);
      }
      await db
        .update(commandOperations)
        .set({
          status: "succeeded",
          actorUserId: commit.actorUserId,
          resultingVersion: commit.resultingVersion,
          result: commit.result as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(keyOf(workspaceId, commandName, idempotencyKey));
      await db.insert(auditEvents).values({
        workspaceId,
        commandOperationId: claim.id,
        actorUserId: commit.actorUserId,
        entityType: commit.audit.entityType,
        entityId: commit.audit.entityId,
        action: commit.audit.action,
        reason: commit.audit.reason ?? null,
        relatedAiRunId: commit.audit.relatedAiRunId ?? null,
        oldValue: commit.audit.oldValue ?? null,
        newValue: commit.audit.newValue ?? null,
      });
      for (const event of commit.outbox) {
        await db.insert(outboxEvents).values({
          workspaceId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          payload: event.payload ?? {},
        });
      }
      return operationId;
    },

    async commitFailure(
      workspaceId: string,
      commandName: string,
      idempotencyKey: string,
    ): Promise<void> {
      await db
        .update(commandOperations)
        .set({ status: "failed", updatedAt: new Date() })
        .where(keyOf(workspaceId, commandName, idempotencyKey));
    },
  };
}
