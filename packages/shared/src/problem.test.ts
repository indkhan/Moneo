import { describe, expect, it } from "vitest";
import {
  DomainError,
  PROBLEM_CODES,
  fromCommandError,
  problemResponse,
  problemTypeFor,
  retryAfterSeconds,
  toInternalProblem,
  toProblemDetails,
} from "./problem.js";

/**
 * Issue 2.3 — problem-details errors.
 *
 * Proves every required code maps to the right HTTP status/title/retry
 * guidance, the RFC 9457 shape holds, validation errors carry field detail,
 * rate limits emit Retry-After, unknown failures never leak internals, and
 * the finance executor's codes land on the right domain errors.
 */
describe("problem-details errors", () => {
  it("declares exactly the ten required codes", () => {
    expect([...PROBLEM_CODES].sort()).toEqual(
      [
        "VALIDATION_FAILED",
        "NOT_FOUND",
        "FORBIDDEN",
        "VERSION_CONFLICT",
        "IDEMPOTENCY_KEY_REUSED",
        "RATE_LIMITED",
        "JOB_REQUIRED",
        "UNKNOWN_OUTCOME",
        "INVARIANT_VIOLATION",
        "DEPENDENCY_UNAVAILABLE",
      ].sort(),
    );
  });

  it("maps every code to its HTTP status", () => {
    const statusOf = (code: (typeof PROBLEM_CODES)[number]) =>
      new DomainError(code, { correlationId: "test" }).status;
    expect(statusOf("VALIDATION_FAILED")).toBe(400);
    expect(statusOf("NOT_FOUND")).toBe(404);
    expect(statusOf("FORBIDDEN")).toBe(403);
    expect(statusOf("VERSION_CONFLICT")).toBe(409);
    expect(statusOf("IDEMPOTENCY_KEY_REUSED")).toBe(409);
    expect(statusOf("RATE_LIMITED")).toBe(429);
    expect(statusOf("JOB_REQUIRED")).toBe(202);
    expect(statusOf("UNKNOWN_OUTCOME")).toBe(500);
    expect(statusOf("INVARIANT_VIOLATION")).toBe(422);
    expect(statusOf("DEPENDENCY_UNAVAILABLE")).toBe(503);
  });

  it("marks only transient failures retryable", () => {
    const retryable = (code: (typeof PROBLEM_CODES)[number]) =>
      new DomainError(code, { correlationId: "test" }).retryable;
    for (const code of ["RATE_LIMITED", "JOB_REQUIRED", "UNKNOWN_OUTCOME", "DEPENDENCY_UNAVAILABLE"] as const) {
      expect(retryable(code)).toBe(true);
    }
    for (const code of ["VALIDATION_FAILED", "NOT_FOUND", "FORBIDDEN", "VERSION_CONFLICT", "IDEMPOTENCY_KEY_REUSED", "INVARIANT_VIOLATION"] as const) {
      expect(retryable(code)).toBe(false);
    }
  });

  it("emits an RFC 9457 body with stable type URIs", () => {
    const error = new DomainError("VERSION_CONFLICT", {
      detail: "stale version: expected 4, current 5",
      details: { expectedVersion: 4, currentVersion: 5 },
      correlationId: "corr-1",
    });
    const problem = toProblemDetails(error, "/api/v1/widgets/w1");
    expect(problem).toEqual({
      type: "https://moneo.app/problems/version-conflict",
      title: "Version conflict",
      status: 409,
      detail: "stale version: expected 4, current 5",
      code: "VERSION_CONFLICT",
      retryable: false,
      correlationId: "corr-1",
      details: { expectedVersion: 4, currentVersion: 5 },
      instance: "/api/v1/widgets/w1",
    });
    // Every code has a distinct kebab-case type URI.
    const types = new Set(PROBLEM_CODES.map(problemTypeFor));
    expect(types.size).toBe(10);
    for (const type of types) {
      expect(type.startsWith("https://moneo.app/problems/")).toBe(true);
    }
  });

  it("omits empty details/errors/instance members", () => {
    const problem = toProblemDetails(new DomainError("NOT_FOUND", { correlationId: "c" }));
    expect(problem).toEqual({
      type: "https://moneo.app/problems/not-found",
      title: "Resource not found",
      status: 404,
      detail: "Resource not found",
      code: "NOT_FOUND",
      retryable: false,
      correlationId: "c",
    });
    expect("details" in problem).toBe(false);
    expect("errors" in problem).toBe(false);
    expect("instance" in problem).toBe(false);
  });

  it("defaults detail to the title and mints a correlation id", () => {
    const error = new DomainError("FORBIDDEN");
    expect(error.detail).toBe("Forbidden");
    expect(error.message).toBe("Forbidden");
    expect(error.correlationId.length).toBeGreaterThan(0);
  });

  it("carries field-level failures for VALIDATION_FAILED", () => {
    const problem = toProblemDetails(
      new DomainError("VALIDATION_FAILED", {
        detail: "2 fields are invalid",
        errors: [
          { field: "label", message: "must not be empty" },
          { field: "amount", message: "must be a decimal string" },
        ],
        correlationId: "c",
      }),
    );
    expect(problem.status).toBe(400);
    expect(problem.errors).toEqual([
      { field: "label", message: "must not be empty" },
      { field: "amount", message: "must be a decimal string" },
    ]);
  });

  it("serves application/problem+json with Retry-After for rate limits", async () => {
    const response = problemResponse(
      new DomainError("RATE_LIMITED", {
        detail: "too many mutations",
        details: { retryAfterSeconds: 7 },
        correlationId: "c",
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("retry-after")).toBe("7");
    const body = (await response.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryable).toBe(true);
  });

  it("serves plain problem responses without Retry-After for other codes", () => {
    const response = problemResponse(new DomainError("NOT_FOUND", { correlationId: "c" }));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("never leaks internals for unknown errors, but keeps them for logs", () => {
    const cause = new Error("column \"secret\" does not exist");
    (cause as Error & { stack?: string }).stack = "Error: column \"secret\" does not exist\n at db.ts:1:1";
    const problem = toInternalProblem(cause, "corr-9");
    expect(problem.status).toBe(500);
    expect(problem.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(problem)).not.toContain("secret");
    expect(JSON.stringify(problem)).not.toContain("db.ts");
    expect(problem.correlationId).toBe("corr-9");
    expect(problem.logged).toBe(cause);
  });

  it("maps executor errors onto domain errors, unknown codes to UNKNOWN_OUTCOME", () => {
    expect(fromCommandError({ code: "FORBIDDEN", message: "no" }, "c").code).toBe("FORBIDDEN");
    const conflict = fromCommandError(
      { code: "VERSION_CONFLICT", message: "stale", details: { currentVersion: 5 } },
      "c",
    );
    expect(conflict.code).toBe("VERSION_CONFLICT");
    expect(conflict.status).toBe(409);
    expect(conflict.details).toEqual({ currentVersion: 5 });
    expect(
      fromCommandError({ code: "IDEMPOTENCY_KEY_REUSED", message: "reused" }, "c").status,
    ).toBe(409);
    expect(
      fromCommandError({ code: "INVARIANT_VIOLATION", message: "bad" }, "c").status,
    ).toBe(422);
    // A future executor code must not crash the mapper: it degrades to
    // UNKNOWN_OUTCOME, which is safe to replay with the same key.
    const unmapped = fromCommandError({ code: "SOMETHING_NEW", message: "?" }, "c");
    expect(unmapped.code).toBe("UNKNOWN_OUTCOME");
    expect(unmapped.retryable).toBe(true);
    expect(unmapped.detail).toContain("same idempotency key");
  });

  it("clamps Retry-After hints", () => {
    expect(retryAfterSeconds(7)).toBe(7);
    expect(retryAfterSeconds(1.2)).toBe(2);
    expect(retryAfterSeconds(-5)).toBe(0);
    expect(retryAfterSeconds(10_000)).toBe(60);
    expect(retryAfterSeconds(Number.NaN)).toBe(60);
    expect(retryAfterSeconds(Number.POSITIVE_INFINITY)).toBe(60);
  });
});
