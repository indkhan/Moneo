import { executeUndo } from "@moneo/db/undo-commands";
import { executeRecordBalance } from "@moneo/db/balance-commands";
import {
  executeAddTags,
  executeExcludeFromAnalytics,
  executeRemoveTags,
  executeSetCategory,
  executeSetCounterparty,
  executeSetNote,
} from "@moneo/db/correction-commands";
import { executeResolveMatch } from "@moneo/db/import-matching";
import { executeFrozenBulk } from "@moneo/db/transaction-bulk";
import {
  executeCreateManualAccount,
  executeCreateManualTransaction,
} from "@moneo/db/manual-commands";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { CommandError, type CommandContext, type CommandOutcome } from "@moneo/finance";
import { DomainError, fromCommandError, problemResponse } from "@moneo/shared/problem";
import { NextResponse } from "next/server";
import { z } from "zod";
import { commandRequestSchema, parseOrProblem } from "./contract";

/**
 * Issue 4.10 — typed command HTTP surface (`POST /api/v1/commands/{name}`).
 *
 * The contract path already exists (Issue 2.9); this epoch hangs the first
 * real commands on it. Each command validates its input through zod FIRST
 * (malformed → VALIDATION_FAILED, never a partial mutation), then executes
 * inside `withWorkspaceTransaction` so the effect, audit row, and outbox
 * event commit atomically. `CommandError` codes map onto the documented
 * problems via `fromCommandError`. Later issues register their commands in
 * `createDrizzleCommandRegistry` without touching this dispatcher.
 */

const isoDateSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "must be a YYYY-MM-DD date");

const signedMinorOrNullSchema = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)$/, "must be signed integer-string minor units")
  .nullable();

export const resolveMatchInputSchema = z.object({
  candidateId: z.uuid("candidate id must be a UUID"),
  decision: z.enum(["link", "distinct"]),
});

const currencyCodeSchema = z.string().regex(/^[A-Za-z]{3}$/, "must be an ISO 4217 code");

export const createManualAccountInputSchema = z.object({
  name: z.string().min(1, "name is required").max(120),
  currencyCode: currencyCodeSchema,
  accountType: z
    .enum(["CHECKING", "SAVINGS", "CASH", "CREDIT", "INVESTMENT", "WALLET", "OTHER"])
    .optional(),
  institutionName: z.string().max(120).nullable().optional(),
  isSpendable: z.boolean().optional(),
  includeInNetWorth: z.boolean().optional(),
});

export const createManualTransactionInputSchema = z.object({
  accountId: z.uuid("account id must be a UUID"),
  effectiveDate: isoDateSchema,
  description: z.string().min(1, "description is required").max(500),
  amountMinor: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/, "must be non-negative integer-string minor units"),
  currencyCode: currencyCodeSchema,
  direction: z.enum(["credit", "debit"]),
  note: z.string().max(2000).nullable().optional(),
});

/**
 * Issue 5.3 — correction command inputs. Boundaries mirror the pure domain
 * rules in `@moneo/finance` corrections: malformed payloads fail zod here
 * (VALIDATION_FAILED) before any command runs; semantic checks (ownership,
 * archived categories, stale versions) stay in the domain layer.
 */
export const setCategoryInputSchema = z.object({
  transactionId: z.uuid("transaction id must be a UUID"),
  categoryId: z.uuid("category id must be a UUID").nullable(),
});

export const setCounterpartyInputSchema = z.object({
  transactionId: z.uuid("transaction id must be a UUID"),
  counterpartyId: z.uuid("counterparty id must be a UUID").nullable().optional(),
  counterpartyName: z.string().max(120).nullable().optional(),
});

const tagListSchema = z.array(z.string().min(1).max(40)).min(1).max(20);

export const addTagsInputSchema = z.object({
  transactionId: z.uuid("transaction id must be a UUID"),
  tags: tagListSchema,
});

export const removeTagsInputSchema = z.object({
  transactionId: z.uuid("transaction id must be a UUID"),
  tags: tagListSchema,
});

export const setNoteInputSchema = z.object({
  transactionId: z.uuid("transaction id must be a UUID"),
  note: z.string().max(2000).nullable(),
});

export const excludeFromAnalyticsInputSchema = z.object({
  transactionId: z.uuid("transaction id must be a UUID"),
  excluded: z.boolean(),
});

const frozenBulkBaseSchema = z.object({ selectionId: z.uuid("selection id must be a UUID") });
export const setCategoryBulkInputSchema = frozenBulkBaseSchema.extend({
  categoryId: z.uuid("category id must be a UUID").nullable(),
});
export const addTagsBulkInputSchema = frozenBulkBaseSchema.extend({ tags: tagListSchema });
export const excludeFromAnalyticsBulkInputSchema = frozenBulkBaseSchema.extend({
  excluded: z.boolean(),
});

/** Issue 5.4 — undo takes the operation id returned by an undoable command. */
export const undoInputSchema = z.object({
  operationId: z.string().min(1, "operation id is required").max(500),
});

export const recordBalanceInputSchema = z.object({
  accountId: z.uuid("account id must be a UUID"),
  observedAt: z.string().min(1, "observedAt is required"),
  currentAmountMinor: signedMinorOrNullSchema,
  availableAmountMinor: signedMinorOrNullSchema.optional(),
  currencyCode: z.string().regex(/^[A-Za-z]{3}$/, "must be an ISO 4217 code"),
  source: z.enum(["statement", "manual", "imported", "other"]),
  cutoffDate: isoDateSchema.nullable(),
  sourceImportId: z.uuid("source import id must be a UUID").nullable().optional(),
});

export interface CommandMetadata {
  idempotencyKey: string;
  expectedVersion?: string;
}

export interface CommandExecution {
  operationId: string;
  replayed: boolean;
  /** True when the client may offer Undo for this outcome (Issue 5.4). */
  undoAvailable: boolean;
  result: Record<string, unknown>;
}

export interface CommandRegistration {
  /** Validated by the dispatcher BEFORE run — run receives trusted input. */
  inputSchema: z.ZodType;
  /** Whether successful outcomes support `operations.undo`. Defaults to false. */
  undoAvailable?: boolean;
  run(args: {
    workspaceId: string;
    actorUserId: string | null;
    metadata: CommandMetadata;
    input: unknown;
  }): Promise<CommandExecution>;
}

export type CommandHandler = CommandRegistration["run"];

/**
 * Wrap one Drizzle correction executor as a registry entry. The dispatcher
 * validates `input` against the zod schema first; `run` only forwards the
 * trusted payload into `withWorkspaceTransaction` like every other command.
 */
function correctionRegistration(
  inputSchema: z.ZodType,
  execute: (
    db: Parameters<typeof executeSetCategory>[0],
    ctx: CommandContext,
    input: unknown,
  ) => Promise<CommandOutcome<unknown>>,
  undoAvailable = false,
): CommandRegistration {
  return {
    inputSchema,
    undoAvailable,
    run: ({ workspaceId, actorUserId, metadata, input }) =>
      withWorkspaceTransaction(workspaceId, (tx) =>
        execute(
          tx,
          {
            workspaceId,
            actorUserId,
            idempotencyKey: metadata.idempotencyKey,
            ...(metadata.expectedVersion !== undefined
              ? { expectedVersion: Number(metadata.expectedVersion) }
              : {}),
          },
          input,
        ).then((outcome) => toExecution(outcome, undoAvailable)),
      ),
  };
}

/** Registry of audited domain commands. Additive: later issues add entries. */
export function createDrizzleCommandRegistry(): Map<string, CommandRegistration> {
  const recordBalance: CommandRegistration = {
    inputSchema: recordBalanceInputSchema,
    run: ({ workspaceId, actorUserId, metadata, input }) =>
      withWorkspaceTransaction(workspaceId, (tx) =>
        executeRecordBalance(
          tx,
          {
            workspaceId,
            actorUserId,
            idempotencyKey: metadata.idempotencyKey,
            ...(metadata.expectedVersion !== undefined
              ? { expectedVersion: Number(metadata.expectedVersion) }
              : {}),
          },
          // Validated against recordBalanceInputSchema by the dispatcher.
          input as Parameters<typeof executeRecordBalance>[2],
        ).then(toExecution),
      ),
  };
  const resolveMatch: CommandRegistration = {
    inputSchema: resolveMatchInputSchema,
    run: ({ workspaceId, actorUserId, metadata, input }) =>
      withWorkspaceTransaction(workspaceId, (tx) =>
        executeResolveMatch(
          tx,
          {
            workspaceId,
            actorUserId,
            idempotencyKey: metadata.idempotencyKey,
            ...(metadata.expectedVersion !== undefined
              ? { expectedVersion: Number(metadata.expectedVersion) }
              : {}),
          },
          // Validated against resolveMatchInputSchema by the dispatcher.
          input as Parameters<typeof executeResolveMatch>[2],
        ).then(toExecution),
      ),
  };
  return new Map<string, CommandRegistration>([
    ["accounts.recordBalance", recordBalance],
    ["matches.resolve", resolveMatch],
    [
      "transactions.setCategory",
      correctionRegistration(
        setCategoryInputSchema,
        (db, ctx, input) =>
          executeSetCategory(db, ctx, input as Parameters<typeof executeSetCategory>[2]),
        true,
      ),
    ],
    [
      "transactions.setCounterparty",
      correctionRegistration(
        setCounterpartyInputSchema,
        (db, ctx, input) =>
          executeSetCounterparty(db, ctx, input as Parameters<typeof executeSetCounterparty>[2]),
        true,
      ),
    ],
    [
      "transactions.addTags",
      correctionRegistration(
        addTagsInputSchema,
        (db, ctx, input) => executeAddTags(db, ctx, input as Parameters<typeof executeAddTags>[2]),
        true,
      ),
    ],
    [
      "transactions.removeTags",
      correctionRegistration(
        removeTagsInputSchema,
        (db, ctx, input) =>
          executeRemoveTags(db, ctx, input as Parameters<typeof executeRemoveTags>[2]),
        true,
      ),
    ],
    [
      "transactions.setNote",
      correctionRegistration(
        setNoteInputSchema,
        (db, ctx, input) => executeSetNote(db, ctx, input as Parameters<typeof executeSetNote>[2]),
        true,
      ),
    ],
    [
      "transactions.excludeFromAnalytics",
      correctionRegistration(
        excludeFromAnalyticsInputSchema,
        (db, ctx, input) =>
          executeExcludeFromAnalytics(
            db,
            ctx,
            input as Parameters<typeof executeExcludeFromAnalytics>[2],
          ),
        true,
      ),
    ],
    [
      "transactions.setCategoryBulk",
      {
        inputSchema: setCategoryBulkInputSchema,
        run: ({ workspaceId, actorUserId, metadata, input }) =>
          withWorkspaceTransaction(workspaceId, (tx) =>
            executeFrozenBulk(tx, {
              workspaceId,
              actorUserId,
              idempotencyKey: metadata.idempotencyKey,
              command: "setCategory",
              ...(input as z.infer<typeof setCategoryBulkInputSchema>),
            }).then((result) => ({
              operationId: `${workspaceId}:transactions.setCategoryBulk:${metadata.idempotencyKey}`,
              replayed: result.applied === 0 && result.replayed > 0,
              undoAvailable: false,
              result: result as unknown as Record<string, unknown>,
            })),
          ),
      },
    ],
    [
      "transactions.addTagsBulk",
      {
        inputSchema: addTagsBulkInputSchema,
        run: ({ workspaceId, actorUserId, metadata, input }) =>
          withWorkspaceTransaction(workspaceId, (tx) =>
            executeFrozenBulk(tx, {
              workspaceId,
              actorUserId,
              idempotencyKey: metadata.idempotencyKey,
              command: "addTags",
              ...(input as z.infer<typeof addTagsBulkInputSchema>),
            }).then((result) => ({
              operationId: `${workspaceId}:transactions.addTagsBulk:${metadata.idempotencyKey}`,
              replayed: result.applied === 0 && result.replayed > 0,
              undoAvailable: false,
              result: result as unknown as Record<string, unknown>,
            })),
          ),
      },
    ],
    [
      "transactions.excludeFromAnalyticsBulk",
      {
        inputSchema: excludeFromAnalyticsBulkInputSchema,
        run: ({ workspaceId, actorUserId, metadata, input }) =>
          withWorkspaceTransaction(workspaceId, (tx) =>
            executeFrozenBulk(tx, {
              workspaceId,
              actorUserId,
              idempotencyKey: metadata.idempotencyKey,
              command: "excludeFromAnalytics",
              ...(input as z.infer<typeof excludeFromAnalyticsBulkInputSchema>),
            }).then((result) => ({
              operationId: `${workspaceId}:transactions.excludeFromAnalyticsBulk:${metadata.idempotencyKey}`,
              replayed: result.applied === 0 && result.replayed > 0,
              undoAvailable: false,
              result: result as unknown as Record<string, unknown>,
            })),
          ),
      },
    ],
    [
      "operations.undo",
      correctionRegistration(undoInputSchema, (db, ctx, input) =>
        executeUndo(db, ctx, input as Parameters<typeof executeUndo>[2]),
      ),
    ],
    [
      "accounts.createManual",
      {
        inputSchema: createManualAccountInputSchema,
        run: ({ workspaceId, actorUserId, metadata, input }) =>
          withWorkspaceTransaction(workspaceId, (tx) =>
            executeCreateManualAccount(
              tx,
              {
                workspaceId,
                actorUserId,
                idempotencyKey: metadata.idempotencyKey,
                ...(metadata.expectedVersion !== undefined
                  ? { expectedVersion: Number(metadata.expectedVersion) }
                  : {}),
              },
              // Validated against createManualAccountInputSchema by the dispatcher.
              input as Parameters<typeof executeCreateManualAccount>[2],
            ).then(toExecution),
          ),
      },
    ],
    [
      "transactions.createManual",
      {
        inputSchema: createManualTransactionInputSchema,
        run: ({ workspaceId, actorUserId, metadata, input }) =>
          withWorkspaceTransaction(workspaceId, (tx) =>
            executeCreateManualTransaction(
              tx,
              {
                workspaceId,
                actorUserId,
                idempotencyKey: metadata.idempotencyKey,
                ...(metadata.expectedVersion !== undefined
                  ? { expectedVersion: Number(metadata.expectedVersion) }
                  : {}),
              },
              // Validated against createManualTransactionInputSchema by the dispatcher.
              input as Parameters<typeof executeCreateManualTransaction>[2],
            ).then(toExecution),
          ),
      },
    ],
  ]);
}

function toExecution(
  outcome: {
    operationId: string;
    replayed: boolean;
    result: unknown;
  },
  undoAvailable = false,
): CommandExecution {
  return {
    operationId: outcome.operationId,
    replayed: outcome.replayed,
    undoAvailable,
    result: outcome.result as Record<string, unknown>,
  };
}

function validationProblem(error: z.ZodError): Response {
  return problemResponse(
    new DomainError("VALIDATION_FAILED", {
      detail: `Request validation failed: ${error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      errors: error.issues.map((issue) => ({
        field: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    }),
  );
}

function unauthorized(): Response {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** POST /api/v1/commands/{commandName} — run one typed domain command. */
export async function handleExecuteCommand(
  commandName: unknown,
  body: unknown,
  ctx: {
    workspaceId: string | undefined;
    actorUserId: string | null | undefined;
    registry: Map<string, CommandRegistration>;
  },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  if (typeof commandName !== "string" || commandName.length === 0) {
    return problemResponse(new DomainError("NOT_FOUND", { detail: "Unknown command." }));
  }
  const parsed = parseOrProblem(commandRequestSchema, body, `/commands/${commandName}`);
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  const registration = ctx.registry.get(commandName);
  if (!registration) {
    return problemResponse(
      new DomainError("NOT_FOUND", { detail: `Unknown command: ${commandName}.` }),
    );
  }
  const inputParsed = registration.inputSchema.safeParse(parsed.data.input);
  if (!inputParsed.success) {
    return validationProblem(inputParsed.error);
  }
  const metadata: CommandMetadata = {
    idempotencyKey: parsed.data.metadata.idempotencyKey,
    ...(parsed.data.metadata.expectedVersion !== undefined
      ? { expectedVersion: parsed.data.metadata.expectedVersion }
      : {}),
  };
  try {
    const outcome = await registration.run({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.actorUserId ?? null,
      metadata,
      input: inputParsed.data,
    });
    return NextResponse.json(outcome);
  } catch (error) {
    if (error instanceof CommandError) {
      return problemResponse(fromCommandError(error));
    }
    if (error instanceof DomainError) {
      return problemResponse(error);
    }
    throw error;
  }
}
