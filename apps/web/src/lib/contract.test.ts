import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DomainError } from "@moneo/shared/problem";
import { ApiError, CONTRACT_SHA, createClient, type JobStatus } from "../generated/client";
import {
  commandRequestSchema,
  cursorQuerySchema,
  jobIdSchema,
  jobSubmitSchema,
  moneyStringSchema,
  parseOrProblem,
  versionStringSchema,
} from "./contract";
import { createJobApi, toUiJob } from "./job-api";

/**
 * Issue 2.9 — API contracts and generated client.
 *
 * Proves the contract is OpenAPI 3.1 with every required surface (problem
 * codes, decimal-string money/version, cursor envelopes, command metadata,
 * job submission/status); the committed client matches the contract
 * byte-for-byte (CI drift check runs the same assertion); the typed client
 * works against a stub transport; malformed requests produce documented
 * VALIDATION_FAILED problems; and the browser job layer consumes only
 * generated DTOs.
 */

const CONTRACT_URL = new URL("../../openapi/openapi.json", import.meta.url);
const contractText = readFileSync(CONTRACT_URL, "utf8");
const contract = JSON.parse(contractText) as {
  openapi: string;
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown>; parameters: Record<string, unknown> };
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("api contract", () => {
  it("is OpenAPI 3.1 with the required paths", () => {
    expect(contract.openapi).toBe("3.1.0");
    for (const path of [
      "/health",
      "/version",
      "/jobs",
      "/jobs/{id}",
      "/jobs/{id}/retry",
      "/jobs/{id}/stop",
      "/commands/{commandName}",
      "/accounts",
      "/accounts/{id}",
      "/transactions/{id}",
      "/transactions/search",
      "/imports/initiate",
      "/imports/bytes",
      "/imports/preview",
      "/imports/complete",
    ]) {
      expect(Object.keys(contract.paths)).toContain(path);
    }
  });

  it("declares the money screens on cursor pages and decimal-string amounts", () => {
    const search = (
      contract.paths["/transactions/search"] as {
        get: { parameters: { name: string }[] };
      }
    ).get;
    const names = search.parameters.map((p) => ("$ref" in p ? p.$ref : p.name));
    expect(names).toContain("#/components/parameters/Cursor");
    expect(names).toContain("#/components/parameters/PageLimit");

    const transaction = contract.components.schemas["Transaction"] as {
      properties: { amountMinor: unknown; direction: { enum: string[] } };
    };
    expect(transaction.properties.amountMinor).toEqual({
      $ref: "#/components/schemas/NonNegativeMinorString",
    });
    expect(transaction.properties.direction.enum).toEqual(["credit", "debit"]);
    const bound = contract.components.schemas["NonNegativeMinorString"] as {
      type: string;
      pattern: string;
    };
    expect(bound.type).toBe("string");
    expect("1550").toMatch(new RegExp(bound.pattern));
    expect("12.50").not.toMatch(new RegExp(bound.pattern));
    expect("-5").not.toMatch(new RegExp(bound.pattern));

    const account = contract.components.schemas["Account"] as {
      required: string[];
    };
    expect(account.required).toContain("balance");
  });

  it("declares every problem code on the shared error schema", () => {
    const problem = contract.components.schemas["ProblemDetails"] as {
      properties: { code: { enum: string[] } };
    };
    expect(problem.properties.code.enum).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  it("keeps money and versions as decimal strings, never numbers", () => {
    const money = contract.components.schemas["MoneyString"] as { type: string; pattern: string };
    expect(money.type).toBe("string");
    expect("^-?[0-9]+$").toBe(money.pattern);
    expect("12.50").not.toMatch(new RegExp(money.pattern));
    expect("1250").toMatch(new RegExp(money.pattern));
    const version = contract.components.schemas["VersionString"] as {
      type: string;
      pattern: string;
    };
    expect(version.type).toBe("string");
    expect("7").toMatch(new RegExp(version.pattern));
    expect("v7").not.toMatch(new RegExp(version.pattern));
  });

  it("pages jobs with an opaque cursor envelope", () => {
    const get = (contract.paths["/jobs"] as { get: { parameters: unknown[] } }).get;
    expect(get.parameters).toHaveLength(2);
    expect(contract.components.parameters["Cursor"]).toBeDefined();
    expect(contract.components.parameters["PageLimit"]).toBeDefined();
  });

  it("requires idempotency metadata on every command", () => {
    const meta = contract.components.schemas["CommandMetadata"] as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(meta.required).toContain("idempotencyKey");
    expect(meta.properties["expectedVersion"]).toBeDefined();
  });
});

describe("generated client drift", () => {
  it("embeds the current contract sha (regenerate, never hand-edit)", () => {
    expect(CONTRACT_SHA).toBe(sha256(contractText));
    const clientSource = readFileSync(new URL("../generated/client.ts", import.meta.url), "utf8");
    expect(clientSource).toContain("GENERATED — do not edit by hand");
    expect(clientSource).toContain(`contractSha: ${sha256(contractText)}`);
  });
});

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const result = handler(url, init);
    return Promise.resolve({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(result),
    });
  }) as typeof fetch;
}

const wireJob: JobStatus = {
  id: "11111111-1111-7111-8111-111111111111",
  type: "import.process",
  status: "running",
  progressStage: "PARSE",
  progressPercent: 40,
  attempts: 1,
  maxAttempts: 5,
  error: null,
  createdAt: "2026-09-12T00:00:00Z",
  updatedAt: "2026-09-12T00:00:00Z",
};

describe("generated client", () => {
  it("lists, reads, retries, stops, submits, and executes through typed methods", async () => {
    const seen: string[] = [];
    const client = createClient({
      fetchFn: stubFetch((url, init) => {
        seen.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/jobs?limit=25")) {
          return { items: [wireJob], nextCursor: null };
        }
        if (url.endsWith("/jobs") && init?.method === "POST") {
          return { ...wireJob, status: "queued" };
        }
        if (url.includes("/retry")) {
          return { ...wireJob, status: "queued", attempts: 2 };
        }
        if (url.includes("/stop")) {
          return { ...wireJob, status: "cancelled" };
        }
        if (url.includes("/commands/")) {
          return { operationId: "ws:cmd:key", replayed: false, result: { ok: true } };
        }
        return wireJob;
      }),
    });

    const page = await client.listJobs({ limit: 25 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect((await client.getJob(wireJob.id)).id).toBe(wireJob.id);
    expect((await client.retryJob(wireJob.id)).attempts).toBe(2);
    expect((await client.stopJob(wireJob.id)).status).toBe("cancelled");
    expect((await client.submitJob({ type: "import.process" })).status).toBe("queued");
    const executed = await client.executeCommand("widgets.rename", {
      metadata: { idempotencyKey: "k" },
      input: { id: "w1" },
    });
    expect(executed.operationId).toBe("ws:cmd:key");
    expect(seen).toContain("GET /api/v1/jobs?limit=25");
  });

  it("throws ApiError with the problem body on documented failures", async () => {
    const problem = {
      type: "https://moneo.app/problems/version-conflict",
      title: "Version conflict",
      status: 409,
      detail: "stale version",
      code: "VERSION_CONFLICT",
      retryable: false,
      correlationId: "c",
    };
    const client = createClient({
      fetchFn: (() =>
        Promise.resolve({
          ok: false,
          status: 409,
          headers: new Headers({ "content-type": "application/problem+json" }),
          json: () => Promise.resolve(problem),
        })) as unknown as typeof fetch,
    });
    const error = await client.getJob(wireJob.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).problem.code).toBe("VERSION_CONFLICT");
  });

  it("degrades non-problem failures to INTERNAL_ERROR without losing the status", async () => {
    const client = createClient({
      fetchFn: (() =>
        Promise.resolve({
          ok: false,
          status: 502,
          headers: new Headers({ "content-type": "text/plain" }),
          json: () => Promise.resolve(null),
        })) as unknown as typeof fetch,
    });
    const error = await client.listJobs().catch((e: unknown) => e);
    expect((error as ApiError).problem.code).toBe("INTERNAL_ERROR");
    expect((error as ApiError).status).toBe(502);
  });
});

describe("server boundary validation", () => {
  it("accepts well-formed command requests", () => {
    const parsed = parseOrProblem(commandRequestSchema, {
      metadata: { idempotencyKey: "key-1", expectedVersion: "3" },
      input: { id: "w1" },
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects malformed commands with field-level VALIDATION_FAILED problems", () => {
    const parsed = parseOrProblem(commandRequestSchema, {
      metadata: { idempotencyKey: "", expectedVersion: "v3" },
      input: "nope",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toBeInstanceOf(DomainError);
      expect(parsed.error.code).toBe("VALIDATION_FAILED");
      expect(parsed.error.status).toBe(400);
      const fields = parsed.error.errors?.map((e) => e.field) ?? [];
      expect(fields.join(",")).toContain("metadata.idempotencyKey");
      expect(fields.join(",")).toContain("metadata.expectedVersion");
      expect(fields.join(",")).toContain("input");
    }
  });

  it("bounds cursor pagination", () => {
    expect(parseOrProblem(cursorQuerySchema, {}).ok).toBe(true);
    expect(parseOrProblem(cursorQuerySchema, { limit: 0 }).ok).toBe(false);
    expect(parseOrProblem(cursorQuerySchema, { limit: 1000 }).ok).toBe(false);
    const capped = parseOrProblem(cursorQuerySchema, { limit: "25" });
    expect(capped.ok && capped.data.limit).toBe(25);
  });

  it("requires a job type and a UUID job id", () => {
    expect(parseOrProblem(jobSubmitSchema, { type: "" }).ok).toBe(false);
    expect(parseOrProblem(jobSubmitSchema, {}).ok).toBe(false);
    expect(parseOrProblem(jobSubmitSchema, { type: "import.process", dedupeKey: "u-1" }).ok).toBe(
      true,
    );
    expect(parseOrProblem(jobIdSchema, wireJob.id).ok).toBe(true);
    expect(parseOrProblem(jobIdSchema, "not-a-uuid").ok).toBe(false);
  });

  it("keeps decimal-string money/version shapes aligned with the contract", () => {
    expect(parseOrProblem(moneyStringSchema, "1250").ok).toBe(true);
    expect(parseOrProblem(moneyStringSchema, "12.50").ok).toBe(false);
    expect(parseOrProblem(moneyStringSchema, 1250).ok).toBe(false);
    expect(parseOrProblem(versionStringSchema, "3").ok).toBe(true);
    expect(parseOrProblem(versionStringSchema, "-1").ok).toBe(false);
  });
});

describe("browser job integration", () => {
  it("maps generated wire DTOs onto drawer view models (no hand DTOs)", () => {
    expect(toUiJob({ ...wireJob, status: "running" })).toMatchObject({
      id: wireJob.id,
      type: "import.process",
      status: "running",
      progressStage: "PARSE",
      progressPercent: 40,
      attempts: 1,
      maxAttempts: 5,
      errorMessage: null,
    });
    expect(
      toUiJob({ ...wireJob, status: "failed", error: { message: "disk full" } }).errorMessage,
    ).toBe("disk full");
    expect(toUiJob({ ...wireJob, error: { code: "X" } }).errorMessage).toBeNull();
  });

  it("fetches job pages through the generated client", async () => {
    const api = createJobApi(stubFetch(() => ({ items: [wireJob], nextCursor: "cursor-2" })));
    const result = await api.fetchJobs(undefined, 25);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ id: wireJob.id, status: "running" });
    expect(result.nextCursor).toBe("cursor-2");
  });
});
