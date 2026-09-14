import { CommandError, type CommandOutcome } from "@moneo/finance";
import type { CommandStoreDb } from "./command-store.js";
import {
  executeAddTags,
  executeExcludeFromAnalytics,
  executeSetCategory,
} from "./correction-commands.js";
import { getFrozenTransactionSelection } from "./transaction-workspace.js";

export type FrozenBulkInput = {
  workspaceId: string;
  actorUserId: string | null;
  idempotencyKey: string;
  selectionId: string;
} & (
  | { command: "setCategory"; categoryId: string | null }
  | { command: "addTags"; tags: string[] }
  | { command: "excludeFromAnalytics"; excluded: boolean }
);

export interface FrozenBulkResult {
  applied: number;
  replayed: number;
  conflicts: string[];
  missing: string[];
}

/**
 * Execute existing audited corrections against an immutable id/version list.
 * Per-row keys make retries replay-safe; stale rows are reported, never forced.
 */
export async function executeFrozenBulk(
  db: CommandStoreDb,
  input: FrozenBulkInput,
): Promise<FrozenBulkResult> {
  const selection = await getFrozenTransactionSelection(db, input.workspaceId, input.selectionId);
  if (!selection) {
    throw new CommandError("FORBIDDEN", "Frozen selection was not found or has expired.");
  }
  const result: FrozenBulkResult = { applied: 0, replayed: 0, conflicts: [], missing: [] };
  for (const item of selection.items) {
    try {
      const ctx = {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        idempotencyKey: `${input.idempotencyKey}:${item.id}`,
        expectedVersion: item.version,
      };
      let outcome: CommandOutcome<unknown>;
      if (input.command === "setCategory") {
        outcome = await executeSetCategory(db, ctx, {
          transactionId: item.id,
          categoryId: input.categoryId,
        });
      } else if (input.command === "addTags") {
        outcome = await executeAddTags(db, ctx, { transactionId: item.id, tags: input.tags });
      } else {
        outcome = await executeExcludeFromAnalytics(db, ctx, {
          transactionId: item.id,
          excluded: input.excluded,
        });
      }
      if (outcome.replayed) result.replayed += 1;
      else result.applied += 1;
    } catch (error) {
      if (error instanceof CommandError && error.code === "VERSION_CONFLICT")
        result.conflicts.push(item.id);
      else if (error instanceof CommandError && error.code === "FORBIDDEN")
        result.missing.push(item.id);
      else throw error;
    }
  }
  return result;
}
