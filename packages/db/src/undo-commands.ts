import { and, eq } from "drizzle-orm";
import {
  createUndoCommand,
  executeCommand,
  type CommandContext,
  type CommandOutcome,
  type UndoInput,
  type UndoResult,
} from "@moneo/finance";
import { createDrizzleCommandStore, type CommandStoreDb } from "./command-store.js";
import { correctionDataOver } from "./correction-commands.js";
import { auditEvents, commandOperations } from "./schema.js";

/**
 * Issue 5.4 — Drizzle wiring for `operations.undo`.
 *
 * Runs inside the caller's `withWorkspaceTransaction`: the compensating
 * write, its audit row, and its outbox event commit atomically with the
 * undo claim, so a retried undo converges instead of compensating twice.
 * Operation lookup is workspace-scoped by construction (the triple
 * `(workspace_id, command_name, idempotency_key)`), so foreign operation
 * ids resolve to null and fail closed in the pure domain layer.
 */

export async function executeUndo(
  db: CommandStoreDb,
  ctx: CommandContext,
  input: UndoInput,
): Promise<CommandOutcome<UndoResult>> {
  return executeCommand(
    createUndoCommand({
      ...correctionDataOver(db),
      async findOperation(workspaceId, commandName, idempotencyKey) {
        const claims = await db
          .select({
            id: commandOperations.id,
            resultingVersion: commandOperations.resultingVersion,
          })
          .from(commandOperations)
          .where(
            and(
              eq(commandOperations.workspaceId, workspaceId),
              eq(commandOperations.commandName, commandName),
              eq(commandOperations.idempotencyKey, idempotencyKey),
              eq(commandOperations.status, "succeeded"),
            ),
          )
          .limit(1);
        const claim = claims[0];
        if (!claim) {
          return null;
        }
        const audits = await db
          .select({
            entityType: auditEvents.entityType,
            entityId: auditEvents.entityId,
            action: auditEvents.action,
            oldValue: auditEvents.oldValue,
            newValue: auditEvents.newValue,
          })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.workspaceId, workspaceId),
              eq(auditEvents.commandOperationId, claim.id),
            ),
          )
          .limit(1);
        const audit = audits[0];
        if (!audit) {
          return null;
        }
        return {
          commandName,
          resultingVersion: claim.resultingVersion,
          entityType: audit.entityType,
          entityId: audit.entityId,
          action: audit.action,
          oldValue: audit.oldValue,
          newValue: audit.newValue,
        };
      },
    }),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}
