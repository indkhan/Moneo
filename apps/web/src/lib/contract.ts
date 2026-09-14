import { z } from "zod";
import { DomainError } from "@moneo/shared/problem";

/**
 * Issue 2.9 — server-boundary validation.
 *
 * These zod schemas mirror `openapi/openapi.json` component schemas
 * (CommandMetadata, cursor params, JobSubmit). Every route handler parses
 * untrusted input through `parseOrProblem` FIRST, so malformed requests
 * always produce the documented VALIDATION_FAILED problem — never a throw,
 * never a partial mutation. Later API issues extend both files together.
 */

export const versionStringSchema = z.string().regex(/^[0-9]+$/, "must be a decimal version string");

export const moneyStringSchema = z
  .string()
  .regex(/^-?[0-9]+$/, "must be decimal-string minor units");

export const commandMetadataSchema = z.object({
  idempotencyKey: z.string().min(1, "idempotencyKey is required").max(128),
  expectedVersion: versionStringSchema.optional(),
});

export const commandRequestSchema = z.object({
  metadata: commandMetadataSchema,
  input: z.record(z.string(), z.unknown()),
});

export const cursorQuerySchema = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const jobSubmitSchema = z.object({
  type: z.string().min(1, "type is required").max(120),
  payload: z.record(z.string(), z.unknown()).optional(),
  dedupeKey: z.string().min(1).max(128).optional(),
});

export const jobIdSchema = z.uuid("job id must be a UUID");

export const accountIdSchema = z.uuid("account id must be a UUID");

export const transactionIdSchema = z.uuid("transaction id must be a UUID");

export const accountListQuerySchema = z.object({
  includeArchived: z.coerce.boolean().optional(),
});

export const categoryListQuerySchema = z.object({
  includeArchived: z.coerce.boolean().optional(),
});

const isoDateSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "must be a YYYY-MM-DD date");

const minorBoundSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "must be non-negative integer-string minor units");

/**
 * Issue 4.7 — transaction search boundary. Shape-only: comma-separated
 * lists stay strings here; value validation (UUIDs, directions, ranges)
 * lives in the domain search (Issue 4.6), the single source of truth, and
 * surfaces as the same VALIDATION_FAILED problem.
 */
export const transactionSearchQuerySchema = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  accountIds: z.string().max(4000).optional(),
  categoryIds: z.string().max(4000).optional(),
  tagNames: z.string().max(2000).optional(),
  dateFrom: isoDateSchema.optional(),
  dateTo: isoDateSchema.optional(),
  directions: z.string().max(64).optional(),
  amountMin: minorBoundSchema.optional(),
  amountMax: minorBoundSchema.optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
});

/** Persisted table state is a typed contract, never an arbitrary JSON blob. */
export const transactionViewDefinitionSchema = z.object({
  filters: z
    .object({
      q: z.string().max(200).optional(),
      accountIds: z.array(z.uuid()).max(100).optional(),
      directions: z
        .array(z.enum(["credit", "debit"]))
        .max(2)
        .optional(),
      dateFrom: isoDateSchema.optional(),
      dateTo: isoDateSchema.optional(),
      categoryIds: z.array(z.uuid()).max(100).optional(),
      tagNames: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      counterpartyIds: z.array(z.uuid()).max(100).optional(),
      excludedFromAnalytics: z.boolean().optional(),
    })
    .default({}),
  sort: z.enum(["newest", "oldest"]).default("newest"),
  visibleColumns: z
    .array(z.enum(["date", "description", "account", "direction", "amount"]))
    .min(1)
    .max(5)
    .default(["date", "description", "account", "direction", "amount"]),
});

export type ParseSuccess<T> = { ok: true; data: T };
export type ParseFailure = { ok: false; error: DomainError };
export type ParseOutcome<T> = ParseSuccess<T> | ParseFailure;

/**
 * Parse untrusted input; on failure return a VALIDATION_FAILED domain error
 * carrying per-field messages (the contract's `errors` member).
 */
export function parseOrProblem<T>(
  schema: z.ZodType<T>,
  data: unknown,
  instance?: string,
): ParseOutcome<T> {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const errors = parsed.error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  return {
    ok: false,
    error: new DomainError("VALIDATION_FAILED", {
      detail: `Request validation failed: ${errors.map((e) => `${e.field} ${e.message}`).join("; ")}`,
      errors,
      ...(instance ? { details: { instance } } : {}),
    }),
  };
}
