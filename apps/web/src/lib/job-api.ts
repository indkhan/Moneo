import { createClient, type FetchFn, type JobStatus } from "../generated/client";
import type { UiJob } from "./jobs";

/**
 * Issue 2.9 — browser integration over the GENERATED client.
 *
 * The shell/job UI never hand-maintains DTOs: it imports wire types from
 * `src/generated/client.ts` and maps them onto view models here. Issue 2.10
 * wires polling/SSE through `fetchJobs`; later epochs reuse `executeCommand`.
 */

export function toUiJob(status: JobStatus): UiJob {
  return {
    id: status.id,
    type: status.type,
    status: status.status,
    progressStage: status.progressStage,
    progressPercent: status.progressPercent,
    attempts: status.attempts,
    maxAttempts: status.maxAttempts,
  errorMessage:
    status.error && typeof status.error["message"] === "string"
      ? status.error["message"]
      : null,
  };
}

export interface JobListResult {
  jobs: UiJob[];
  nextCursor: string | null;
}

export function createJobApi(fetchFn?: FetchFn) {
  const client = createClient(fetchFn ? { fetchFn } : {});
  return {
    async fetchJobs(cursor?: string, limit?: number): Promise<JobListResult> {
      const page = await client.listJobs({ ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) });
      return { jobs: page.items.map(toUiJob), nextCursor: page.nextCursor };
    },
    async retryJob(id: string): Promise<UiJob> {
      return toUiJob(await client.retryJob(id));
    },
    async stopJob(id: string): Promise<UiJob> {
      return toUiJob(await client.stopJob(id));
    },
  };
}

export type JobApi = ReturnType<typeof createJobApi>;
