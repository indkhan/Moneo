import { findBackgroundJob, insertBackgroundJob } from "@moneo/db/job-queue";
import type { BackgroundJob } from "@moneo/db/schema";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { DomainError, problemResponse } from "@moneo/shared/problem";
import { NextResponse } from "next/server";
import type { JobStatus } from "../generated/client";
import { jobIdSchema, jobSubmitSchema, parseOrProblem } from "./contract";

/**
 * Issue 3.7 — minimal durable-job HTTP surface for the import wizard.
 *
 * Only what the wizard needs: submit an `import.process` job (idempotent
 * per dedupe key, so double-clicks and retries enqueue once) and read one
 * job's status for the processing poll. Writes run inside
 * `withWorkspaceTransaction`, so rows land tenant-bound and RLS keeps every
 * read scoped. Execution transport (BullMQ pickup of these rows) arrives
 * with the worker runtime wiring; the ROW is the durability the wizard
 * resumes from when the browser reopens.
 *
 * Storage is injected (`JobSubmissionStore`) so handlers unit-test without
 * Postgres; the route default is the Drizzle implementation below.
 */

export const SUBMITTABLE_JOB_TYPES = ["import.process"] as const;

export interface JobSubmissionStore {
  submit(input: {
    workspaceId: string;
    type: string;
    dedupeKey?: string;
    payload?: Record<string, unknown>;
  }): Promise<{ job: BackgroundJob; created: boolean }>;
  find(workspaceId: string, id: string): Promise<BackgroundJob | null>;
}

export function createDrizzleJobSubmissionStore(): JobSubmissionStore {
  return {
    submit: (input) =>
      withWorkspaceTransaction(input.workspaceId, (tx) => insertBackgroundJob(tx, input)),
    find: (workspaceId, id) =>
      withWorkspaceTransaction(workspaceId, (tx) => findBackgroundJob(tx, workspaceId, id)),
  };
}

export function toJobStatus(job: BackgroundJob): JobStatus {
  return {
    id: job.id,
    type: job.type,
    status: job.status as JobStatus["status"],
    progressStage: job.progressStage,
    progressPercent: job.progressPercent,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.error,
    result: job.result,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function unauthorized(): Response {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** POST /api/v1/jobs — submit a wizard import job (202, idempotent). */
export async function handleSubmitJob(
  body: unknown,
  ctx: { workspaceId: string | undefined; jobs: JobSubmissionStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const parsed = parseOrProblem(jobSubmitSchema, body, "/jobs");
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  if (!(SUBMITTABLE_JOB_TYPES as readonly string[]).includes(parsed.data.type)) {
    return problemResponse(
      new DomainError("INVARIANT_VIOLATION", {
        detail: `Job type "${parsed.data.type}" is not submittable yet.`,
      }),
    );
  }
  const { job } = await ctx.jobs.submit({
    workspaceId: ctx.workspaceId,
    type: parsed.data.type,
    ...(parsed.data.dedupeKey !== undefined ? { dedupeKey: parsed.data.dedupeKey } : {}),
    ...(parsed.data.payload !== undefined ? { payload: parsed.data.payload } : {}),
  });
  return NextResponse.json(toJobStatus(job), { status: 202 });
}

/** GET /api/v1/jobs/{id} — one job's status for the processing poll. */
export async function handleGetJob(
  id: unknown,
  ctx: { workspaceId: string | undefined; jobs: JobSubmissionStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const parsed = parseOrProblem(jobIdSchema, id, "/jobs/{id}");
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  const job = await ctx.jobs.find(ctx.workspaceId, parsed.data);
  if (!job) {
    return problemResponse(new DomainError("NOT_FOUND", { detail: "Job not found." }));
  }
  return NextResponse.json(toJobStatus(job));
}
