/**
 * Issue 2.8 — durable-job status UI helpers.
 *
 * All copy, eligibility, and progress math lives here as pure functions so it
 * is unit-testable without a browser. `JobIndicator` / `JobDrawer` only
 * render what these helpers return; data fetching arrives with Issues 2.9+
 * (the components take `jobs` as props, so no fetching logic is baked in).
 */

export type UiJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface UiJob {
  id: string;
  type: string;
  status: UiJobStatus;
  /** Free-form stage for the detail drawer, e.g. `PARSE`. */
  progressStage: string | null;
  /** 0–100, or null when the job reports no percent. */
  progressPercent: number | null;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
}

export interface UiJobView extends UiJob {
  statusLabel: string;
  progressLabel: string;
  clampedPercent: number | null;
  canStop: boolean;
  canRetry: boolean;
}

/** Failed jobs with budget left are retryable; nothing else is. */
export function isRetryEligible(job: Pick<UiJob, "status" | "attempts" | "maxAttempts">): boolean {
  return job.status === "failed" && job.attempts < job.maxAttempts;
}

/** Only live jobs can be stopped. Terminal rows keep a disabled Stop for context. */
export function isStoppable(job: Pick<UiJob, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

export function statusLabel(status: UiJobStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** Clamp reported percents into [0, 100]; null stays null (stage-only jobs). */
export function clampPercent(percent: number | null): number | null {
  if (percent === null || Number.isNaN(percent)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.floor(percent)));
}

export function progressLabel(job: Pick<UiJob, "progressStage" | "progressPercent">): string {
  const percent = clampPercent(job.progressPercent);
  if (job.progressStage && percent !== null) {
    return `${job.progressStage} · ${percent}%`;
  }
  if (job.progressStage) {
    return job.progressStage;
  }
  if (percent !== null) {
    return `${percent}%`;
  }
  return "No progress reported";
}

export function toJobView(job: UiJob): UiJobView {
  return {
    ...job,
    statusLabel: statusLabel(job.status),
    progressLabel: progressLabel(job),
    clampedPercent: clampPercent(job.progressPercent),
    canStop: isStoppable(job),
    canRetry: isRetryEligible(job),
  };
}

/** Live jobs first, failed next (needs attention), then the rest by attempts. */
export function sortJobsForDrawer(jobs: readonly UiJob[]): UiJob[] {
  const rank = (status: UiJobStatus): number =>
    status === "running" ? 0 : status === "queued" ? 1 : status === "failed" ? 2 : 3;
  return [...jobs].sort((a, b) => rank(a.status) - rank(b.status) || b.attempts - a.attempts);
}

export function runningCount(jobs: readonly Pick<UiJob, "status">[]): number {
  return jobs.filter((j) => j.status === "running" || j.status === "queued").length;
}

export function indicatorLabel(jobs: readonly Pick<UiJob, "status">[]): string {
  const live = runningCount(jobs);
  return live === 0 ? "Background jobs: idle" : `Background jobs: ${live} active`;
}
