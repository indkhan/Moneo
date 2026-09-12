import { executeRecordBalance } from "@moneo/db/balance-commands";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { CommandError } from "@moneo/finance";
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
  result: Record<string, unknown>;
}

export interface CommandRegistration {
  /** Validated by the dispatcher BEFORE run — run receives trusted input. */
  inputSchema: z.ZodType;
  run(args: {
    workspaceId: string;
    actorUserId: string | null;
    metadata: CommandMetadata;
    input: unknown;
  }): Promise<CommandExecution>;
}

export type CommandHandler = CommandRegistration["run"];

/** Registry of audited domain commands. Additive: later issues add entries. */
export function createDrizzleCommandRegistry(): Map<string, CommandRegistration> {
  return new Map<string, CommandRegistration>([
    [
      "accounts.recordBalance",
      {
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
            ).then((outcome) => ({
              operationId: outcome.operationId,
              replayed: outcome.replayed,
              result: outcome.result as unknown as Record<string, unknown>,
            })),
          ),
      },
    ],
  ]);
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
