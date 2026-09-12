/**
 * Issue 2.3 — machine-readable domain errors (RFC 9457 problem details).
 *
 * Every API failure returns `application/problem+json` with a stable `code`
 * from the closed set below. Clients switch on `code`, never on message
 * text. HTTP statuses follow the obvious mapping; `retryable` tells the
 * caller whether retrying (with the SAME idempotency key for mutations) can
 * help. Nothing here leaks internals: unknown errors collapse to a generic
 * 500 with a correlation id.
 */

export const PROBLEM_CODES = [
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
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

const STATUS_OF: Record<ProblemCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RATE_LIMITED: 429,
  // The request is valid but needs background execution: accepted, poll the job.
  JOB_REQUIRED: 202,
  // The mutation may or may not have applied (e.g. timeout after commit):
  // safe to replay ONLY with the same idempotency key.
  UNKNOWN_OUTCOME: 500,
  INVARIANT_VIOLATION: 422,
  DEPENDENCY_UNAVAILABLE: 503,
};

const TITLE_OF: Record<ProblemCode, string> = {
  VALIDATION_FAILED: "Request validation failed",
  NOT_FOUND: "Resource not found",
  FORBIDDEN: "Forbidden",
  VERSION_CONFLICT: "Version conflict",
  IDEMPOTENCY_KEY_REUSED: "Idempotency key already used",
  RATE_LIMITED: "Rate limit exceeded",
  JOB_REQUIRED: "Background job required",
  UNKNOWN_OUTCOME: "Unknown outcome",
  INVARIANT_VIOLATION: "Domain invariant violated",
  DEPENDENCY_UNAVAILABLE: "Dependency unavailable",
};

const RETRYABLE_OF: Record<ProblemCode, boolean> = {
  VALIDATION_FAILED: false,
  NOT_FOUND: false,
  FORBIDDEN: false,
  VERSION_CONFLICT: false,
  IDEMPOTENCY_KEY_REUSED: false,
  RATE_LIMITED: true,
  JOB_REQUIRED: true,
  UNKNOWN_OUTCOME: true,
  INVARIANT_VIOLATION: false,
  DEPENDENCY_UNAVAILABLE: true,
};

export interface DomainErrorOptions {
  detail?: string;
  /** Field-level failures for VALIDATION_FAILED. */
  errors?: readonly { field: string; message: string }[];
  /** Extra machine-readable context (versions, limits, job ids). Never secrets. */
  details?: Record<string, unknown>;
  /** Correlate with server logs. Generated when omitted. */
  correlationId?: string;
}

export class DomainError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly detail: string;
  readonly errors: readonly { field: string; message: string }[] | undefined;
  readonly details: Record<string, unknown>;
  readonly correlationId: string;

  constructor(code: ProblemCode, options: DomainErrorOptions = {}) {
    super(options.detail ?? TITLE_OF[code]);
    this.name = "DomainError";
    this.code = code;
    this.status = STATUS_OF[code];
    this.retryable = RETRYABLE_OF[code];
    this.detail = options.detail ?? TITLE_OF[code];
    this.errors = options.errors;
    this.details = options.details ?? {};
    this.correlationId =
      options.correlationId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ProblemCode | "INTERNAL_ERROR";
  retryable: boolean;
  correlationId: string;
  errors?: readonly { field: string; message: string }[];
  details?: Record<string, unknown>;
  instance?: string;
}

/** `type` URIs are stable documentation anchors, one per code. */
export function problemTypeFor(code: ProblemCode | "INTERNAL_ERROR"): string {
  return `https://moneo.app/problems/${code.toLowerCase().replace(/_/g, "-")}`;
}

export function toProblemDetails(error: DomainError, instance?: string): ProblemDetails {
  const problem: ProblemDetails = {
    type: problemTypeFor(error.code),
    title: TITLE_OF[error.code],
    status: error.status,
    detail: error.detail,
    code: error.code,
    retryable: error.retryable,
    correlationId: error.correlationId,
    ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    ...(error.errors ? { errors: error.errors } : {}),
    ...(instance ? { instance } : {}),
  };
  return problem;
}

export interface UnknownErrorProblem {
  problem: ProblemDetails;
}

/**
 * Last-resort mapping: never leak stack traces or driver messages to the
 * client. The original error is returned for server-side logging.
 */
export function toInternalProblem(error: unknown, correlationId?: string): ProblemDetails & {
  logged: unknown;
} {
  const id =
    correlationId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    type: problemTypeFor("INTERNAL_ERROR"),
    title: "Internal server error",
    status: 500,
    detail: "An unexpected error occurred. Retry with the same idempotency key.",
    code: "INTERNAL_ERROR",
    retryable: true,
    correlationId: id,
    logged: error,
  };
}

/**
 * Map the finance command executor's typed errors (Issue 2.2) onto domain
 * errors. The executor only throws the four codes in the map; anything else
 * becomes UNKNOWN_OUTCOME (the mutation may have committed).
 */
export function fromCommandError(
  error: { code: string; message: string; details?: Record<string, unknown> },
  correlationId?: string,
): DomainError {
  switch (error.code) {
    case "FORBIDDEN":
      return new DomainError("FORBIDDEN", { detail: error.message, correlationId });
    case "VERSION_CONFLICT":
      return new DomainError("VERSION_CONFLICT", {
        detail: error.message,
        details: error.details,
        correlationId,
      });
    case "IDEMPOTENCY_KEY_REUSED":
      return new DomainError("IDEMPOTENCY_KEY_REUSED", {
        detail: error.message,
        details: error.details,
        correlationId,
      });
    case "INVARIANT_VIOLATION":
      return new DomainError("INVARIANT_VIOLATION", {
        detail: error.message,
        details: error.details,
        correlationId,
      });
    default:
      return new DomainError("UNKNOWN_OUTCOME", {
        detail: `Command failed with an unmapped error (${error.code}). Replay with the same idempotency key to recover safely.`,
        details: error.details,
        correlationId,
      });
  }
}

/** Retry-After seconds for rate-limit responses (honors the limit's hint, capped). */
export function retryAfterSeconds(requested: number, max = 60): number {
  if (!Number.isFinite(requested)) {
    return max;
  }
  return Math.min(Math.max(Math.ceil(requested), 0), max);
}

/** Smallest Next.js/Route-handler adapter: `return problemResponse(err)`. */
export function problemResponse(error: DomainError, instance?: string): Response {
  const headers = new Headers({ "content-type": "application/problem+json" });
  if (error.code === "RATE_LIMITED") {
    const after = error.details["retryAfterSeconds"];
    headers.set("retry-after", String(retryAfterSeconds(typeof after === "number" ? after : 60)));
  }
  return new Response(JSON.stringify(toProblemDetails(error, instance)), {
    status: error.status,
    headers,
  });
}
