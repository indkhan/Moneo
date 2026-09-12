import { CommandError, type CommandDefinition, type CommandMutation } from "./commands.js";
import type { CorrectionData, CorrectionPatch } from "./corrections.js";

/**
 * Issue 5.4 — safe compensating undo (pure domain).
 *
 * Undo is another command, never a history rewind (`operations.undo`):
 *
 *   1. resolve the `operationId` (`{workspace}:{command}:{key}`) to its
 *      stored command row plus the audit row it wrote;
 *   2. refuse unknown/foreign operations (FORBIDDEN) and non-undoable or
 *      already-undone actions (INVARIANT_VIOLATION);
 *   3. compare the transaction's CURRENT version with the version the
 *      original operation left behind — a newer change means UNDO_CONFLICT,
 *      never an overwrite of newer work (Epoch 5 acceptance);
 *   4. apply the compensating patch as a guarded write, append a second
 *      audit row (`operations.undo`), and emit `transaction.correction_undone`.
 *
 * Audit rows carry full before/after values (Issue 5.3), so every
 * compensation restores the recorded `oldValue` verbatim. Tag commands
 * restore the exact recorded tag SET, not a delta: concurrent tag edits
 * after the operation already fail step 3, so the set cannot have moved
 * under us once we pass the check.
 */

/** Actions the registry knows how to compensate. `operations.undo` is absent by design. */
export const UNDOABLE_ACTIONS = [
  "transactions.setCategory",
  "transactions.setCounterparty",
  "transactions.addTags",
  "transactions.removeTags",
  "transactions.setNote",
  "transactions.excludeFromAnalytics",
] as const;

export type UndoableAction = (typeof UNDOABLE_ACTIONS)[number];

export interface UndoOperation {
  commandName: string;
  /** Entity version the original operation left behind. */
  resultingVersion: number | null;
  entityType: string;
  entityId: string;
  action: string;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
}

export interface UndoData extends CorrectionData {
  /**
   * Resolve one stored operation in this workspace: its command row plus
   * the audit row it wrote. Null when unknown (or foreign — the store
   * scopes the lookup, so callers cannot probe other workspaces).
   */
  findOperation(
    workspaceId: string,
    commandName: string,
    idempotencyKey: string,
  ): Promise<UndoOperation | null>;
}

export interface UndoInput {
  operationId: string;
}

export interface UndoResult {
  undoneOperationId: string;
  transactionId: string;
  version: number;
}

interface Compensation {
  patch: CorrectionPatch;
  /** Exact tag set to restore; null when the action does not touch tags. */
  restoreTags: string[] | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Translate a recorded audit `oldValue` back into a corrective write. */
export function compensationFor(action: string, oldValue: Record<string, unknown> | null): Compensation {
  const old = oldValue ?? {};
  switch (action) {
    case "transactions.setCategory":
      return { patch: { categoryId: stringOrNull(old["categoryId"]) }, restoreTags: null };
    case "transactions.setCounterparty":
      return { patch: { counterpartyId: stringOrNull(old["counterpartyId"]) }, restoreTags: null };
    case "transactions.setNote":
      return { patch: { note: stringOrNull(old["note"]) }, restoreTags: null };
    case "transactions.excludeFromAnalytics":
      return {
        patch: { excludedFromAnalytics: old["excludedFromAnalytics"] === true },
        restoreTags: null,
      };
    case "transactions.addTags":
    case "transactions.removeTags": {
      const tags = old["tags"];
      if (!Array.isArray(tags) || !tags.every((t): t is string => typeof t === "string")) {
        throw new CommandError(
          "INVARIANT_VIOLATION",
          `Operation ${action} has no restorable tag set and cannot be undone.`,
        );
      }
      return { patch: {}, restoreTags: [...tags] };
    }
    default:
      throw new CommandError(
        "INVARIANT_VIOLATION",
        `Operation ${action} is not undoable.`,
      );
  }
}

/**
 * Split `{workspace}:{command}:{key}` on its first two colons. Workspace ids
 * and command names never contain colons, so the remainder (which may) is
 * the key. Anything malformed fails closed as FORBIDDEN.
 */
export function parseOperationId(operationId: unknown): {
  workspaceId: string;
  commandName: string;
  idempotencyKey: string;
} {
  if (typeof operationId !== "string") {
    throw new CommandError("FORBIDDEN", "Operation not found in this workspace.");
  }
  const first = operationId.indexOf(":");
  const second = operationId.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1 || second >= operationId.length - 1) {
    throw new CommandError("FORBIDDEN", "Operation not found in this workspace.");
  }
  return {
    workspaceId: operationId.slice(0, first),
    commandName: operationId.slice(first + 1, second),
    idempotencyKey: operationId.slice(second + 1),
  };
}

/** `operations.undo`: compensate one undoable correction, version-checked. */
export function createUndoCommand(
  data: UndoData,
): CommandDefinition<
  {
    workspaceId: string;
    operationId: string;
    operation: UndoOperation | null;
    transactionId: string | null;
    transaction: Awaited<ReturnType<CorrectionData["findTransaction"]>>;
    compensation: Compensation | null;
  },
  UndoInput,
  UndoResult
> {
  return {
    name: "operations.undo",
    authorize: () => {},
    async loadState(ctx, input) {
      const parsed = parseOperationId(input.operationId);
      if (parsed.workspaceId !== ctx.workspaceId) {
        throw new CommandError("FORBIDDEN", "Operation not found in this workspace.");
      }
      const operation =
        parsed.commandName === "operations.undo"
          ? null
          : await data.findOperation(ctx.workspaceId, parsed.commandName, parsed.idempotencyKey);
      const transactionId = operation ? operation.entityId : null;
      const transaction =
        transactionId === null
          ? null
          : await data.findTransaction(ctx.workspaceId, transactionId);
      return {
        workspaceId: ctx.workspaceId,
        operationId: input.operationId,
        operation,
        transactionId,
        transaction,
        compensation: null,
      };
    },
    currentVersionOf: (state) => state.transaction?.version ?? null,
    checkInvariant(state) {
      const operation = state.operation;
      if (!operation || !state.transactionId) {
        throw new CommandError("FORBIDDEN", "Operation not found in this workspace.");
      }
      if (operation.entityType !== "transaction") {
        throw new CommandError("INVARIANT_VIOLATION", "Only transaction corrections can be undone.");
      }
      if (!state.transaction) {
        throw new CommandError("FORBIDDEN", "Operation not found in this workspace.");
      }
      if (!(UNDOABLE_ACTIONS as readonly string[]).includes(operation.action)) {
        throw new CommandError(
          "INVARIANT_VIOLATION",
          `Operation ${operation.action} is not undoable.`,
        );
      }
      if (operation.resultingVersion === null) {
        throw new CommandError("INVARIANT_VIOLATION", "Operation has no restorable version.");
      }
      if (state.transaction.version !== operation.resultingVersion) {
        throw new CommandError(
          "UNDO_CONFLICT",
          `Transaction changed after ${state.operationId}: current version ${state.transaction.version}, undone operation left ${operation.resultingVersion}`,
          {
            currentVersion: state.transaction.version,
            undoneVersion: operation.resultingVersion,
          },
        );
      }
    },
    async mutate(state) {
      const operation = state.operation;
      const transaction = state.transaction;
      const transactionId = state.transactionId;
      if (!operation || !transaction || !transactionId) {
        throw new CommandError("FORBIDDEN", "Operation not found in this workspace.");
      }
      const compensation = compensationFor(operation.action, operation.oldValue);
      if (compensation.restoreTags !== null) {
        const ids: string[] = [];
        for (const name of compensation.restoreTags) {
          ids.push((await data.findOrCreateTag(state.workspaceId, name)).id);
        }
        await data.replaceTagLinks(state.workspaceId, transactionId, ids);
      }
      const applied = await data.applyCorrection(
        state.workspaceId,
        transactionId,
        compensation.patch,
        transaction.version,
      );
      if (!applied) {
        throw new CommandError(
          "UNDO_CONFLICT",
          `Transaction changed after ${state.operationId} and cannot be undone safely`,
          { currentVersion: transaction.version },
        );
      }
      const after =
        compensation.restoreTags !== null
          ? compensation.restoreTags
          : undefined;
      const mutation: CommandMutation<UndoResult> = {
        resultingVersion: applied.version,
        result: {
          undoneOperationId: state.operationId,
          transactionId,
          version: applied.version,
        },
        audit: {
          entityType: "transaction",
          entityId: transactionId,
          action: "operations.undo",
          oldValue: {
            undoneOperation: state.operationId,
            undoneAction: operation.action,
            ...(operation.newValue ?? {}),
            version: transaction.version,
          },
          newValue: {
            undoneOperation: state.operationId,
            undoneAction: operation.action,
            ...(operation.oldValue ?? {}),
            ...(after !== undefined ? { tags: after } : {}),
            version: applied.version,
          },
        },
        outbox: [
          {
            aggregateType: "transaction",
            aggregateId: transactionId,
            eventType: "transaction.correction_undone",
            payload: {
              transactionId,
              undoneOperation: state.operationId,
              undoneAction: operation.action,
              version: applied.version,
            },
          },
        ],
      };
      return mutation;
    },
  };
}
