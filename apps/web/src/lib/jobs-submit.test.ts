import type { BackgroundJob } from "@moneo/db/schema";
import { describe, expect, it } from "vitest";
import { handleGetJob, handleSubmitJob, toJobStatus, type JobSubmissionStore } from "./jobs-submit";

/**
 * Issue 3.7 — minimal durable-job HTTP surface for the import wizard.
 *
 * Proves: 401 without a workspace on both endpoints; malformed submits and
 * ids rejected as problem+json; non-wizard job types refused; submit stores
 * a queued row and answers 202 with the contract shape; repeated dedupe
 * submits return the SAME job (no double queue); unknown job ids 404; and
 * tenants cannot read each other's jobs.
 */

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

function row(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  const now = new Date("2026-09-12T12:00:00.000Z");
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: WS_A,
    type: "import.process",
    status: "queued",
    dedupeKey: null,
    payload: {},
    result: null,
    error: null,
    attempts: 0,
    maxAttempts: 5,
    runAfter: now,
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    progressStage: null,
    progressPercent: null,
    cancelledAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function memoryJobs(): JobSubmissionStore & { rows(): BackgroundJob[] } {
  const jobs = new Map<string, BackgroundJob>();
  let ids = 0;
  return {
    rows: () => [...jobs.values()],
    submit: (input) => {
      if (input.dedupeKey !== undefined) {
        const hit = [...jobs.values()].find(
          (j) =>
            j.workspaceId === input.workspaceId &&
            j.type === input.type &&
            j.dedupeKey === input.dedupeKey,
        );
        if (hit) {
          return Promise.resolve({ job: hit, created: false });
        }
      }
      ids += 1;
      const job = row({
        id: `00000000-0000-4000-8000-0000000000${String(ids).padStart(2, "0")}`,
        workspaceId: input.workspaceId,
        type: input.type,
        dedupeKey: input.dedupeKey ?? null,
        payload: input.payload ?? {},
      });
      jobs.set(job.id, job);
      return Promise.resolve({ job, created: true });
    },
    find: (workspaceId, id) => {
      const job = jobs.get(id);
      return Promise.resolve(job && job.workspaceId === workspaceId ? job : null);
    },
  };
}

async function readProblem(response: Response): Promise<{ status: number; code: string }> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const body = (await response.json()) as { code: string };
  return { status: response.status, code: body.code };
}

describe("toJobStatus", () => {
  it("maps the row onto the contract shape", () => {
    expect(toJobStatus(row({ result: { newCount: 2, errorCount: 1 } }))).toMatchObject({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      type: "import.process",
      status: "queued",
      attempts: 0,
      maxAttempts: 5,
      createdAt: "2026-09-12T12:00:00.000Z",
      result: { newCount: 2, errorCount: 1 },
    });
  });
});

describe("handleSubmitJob", () => {
  it("returns 401 without a workspace", async () => {
    const response = await handleSubmitJob(
      { type: "import.process" },
      {
        workspaceId: undefined,
        jobs: memoryJobs(),
      },
    );
    expect(response.status).toBe(401);
  });

  it("rejects malformed bodies", async () => {
    const jobs = memoryJobs();
    expect(
      await readProblem(await handleSubmitJob({ type: "" }, { workspaceId: WS_A, jobs })),
    ).toEqual({ status: 400, code: "VALIDATION_FAILED" });
    expect(jobs.rows()).toHaveLength(0);
  });

  it("refuses job types outside the wizard allowlist", async () => {
    const jobs = memoryJobs();
    const response = await handleSubmitJob({ type: "report.build" }, { workspaceId: WS_A, jobs });
    expect(await readProblem(response)).toEqual({ status: 422, code: "INVARIANT_VIOLATION" });
    expect(jobs.rows()).toHaveLength(0);
  });

  it("submits once and answers 202 with the queued job", async () => {
    const jobs = memoryJobs();
    const response = await handleSubmitJob(
      { type: "import.process", dedupeKey: "stmt-1", payload: { importId: "i-1" } },
      { workspaceId: WS_A, jobs },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { id: string; status: string; type: string };
    expect(body).toMatchObject({ status: "queued", type: "import.process" });
    expect(jobs.rows()).toHaveLength(1);
  });

  it("returns the same job for a repeated dedupe key", async () => {
    const jobs = memoryJobs();
    const first = (await (
      await handleSubmitJob(
        { type: "import.process", dedupeKey: "stmt-1" },
        {
          workspaceId: WS_A,
          jobs,
        },
      )
    ).json()) as { id: string };
    const second = (await (
      await handleSubmitJob(
        { type: "import.process", dedupeKey: "stmt-1" },
        {
          workspaceId: WS_A,
          jobs,
        },
      )
    ).json()) as { id: string };
    expect(second.id).toBe(first.id);
    expect(jobs.rows()).toHaveLength(1);
  });
});

describe("handleGetJob", () => {
  it("returns 401 without a workspace", async () => {
    const response = await handleGetJob("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      workspaceId: undefined,
      jobs: memoryJobs(),
    });
    expect(response.status).toBe(401);
  });

  it("rejects malformed ids and misses unknown jobs", async () => {
    const jobs = memoryJobs();
    expect(await readProblem(await handleGetJob("nope", { workspaceId: WS_A, jobs }))).toEqual({
      status: 400,
      code: "VALIDATION_FAILED",
    });
    expect(
      await readProblem(
        await handleGetJob("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { workspaceId: WS_A, jobs }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  it("reads back the submitted job but never another workspace's", async () => {
    const jobs = memoryJobs();
    const submitted = (await (
      await handleSubmitJob({ type: "import.process" }, { workspaceId: WS_A, jobs })
    ).json()) as { id: string };
    const found = await handleGetJob(submitted.id, { workspaceId: WS_A, jobs });
    expect(found.status).toBe(200);
    const foreign = await handleGetJob(submitted.id, { workspaceId: WS_B, jobs });
    expect(await readProblem(foreign)).toEqual({ status: 404, code: "NOT_FOUND" });
  });
});
