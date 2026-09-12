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

export const moneyStringSchema = z.string().regex(/^-?[0-9]+$/, "must be decimal-string minor units");

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
