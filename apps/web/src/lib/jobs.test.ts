import { describe, expect, it } from "vitest";
import {
  clampPercent,
  indicatorLabel,
  isRetryEligible,
  isStoppable,
  progressLabel,
  runningCount,
  sortJobsForDrawer,
  statusLabel,
  toJobView,
  type UiJob,
} from "./jobs";

/**
 * Issue 2.8 — job UI helpers. Every rule the drawer renders is pinned here:
 * retry eligibility, stop eligibility, labels, percent clamping, ordering,
 * and the shell indicator copy.
 */
function job(overrides: Partial<UiJob> = {}): UiJob {
  return {
    id: "j1",
    type: "import.process",
    status: "running",
    progressStage: "PARSE",
    progressPercent: 40,
    attempts: 1,
    maxAttempts: 5,
    errorMessage: null,
    ...overrides,
  };
}

describe("job ui helpers", () => {
  it("retries exactly failed jobs with budget left", () => {
    expect(isRetryEligible(job({ status: "failed", attempts: 2, maxAttempts: 5 }))).toBe(true);
    expect(isRetryEligible(job({ status: "failed", attempts: 5, maxAttempts: 5 }))).toBe(false);
    expect(isRetryEligible(job({ status: "failed", attempts: 9, maxAttempts: 5 }))).toBe(false);
    for (const status of ["queued", "running", "succeeded", "cancelled"] as const) {
      expect(isRetryEligible(job({ status, attempts: 0 }))).toBe(false);
    }
  });

  it("stops exactly live jobs", () => {
    expect(isStoppable(job({ status: "queued" }))).toBe(true);
    expect(isStoppable(job({ status: "running" }))).toBe(true);
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      expect(isStoppable(job({ status }))).toBe(false);
    }
  });

  it("labels every status", () => {
    expect(statusLabel("queued")).toBe("Queued");
    expect(statusLabel("running")).toBe("Running");
    expect(statusLabel("succeeded")).toBe("Succeeded");
    expect(statusLabel("failed")).toBe("Failed");
    expect(statusLabel("cancelled")).toBe("Cancelled");
  });

  it("clamps percents into [0, 100] and keeps null null", () => {
    expect(clampPercent(40)).toBe(40);
    expect(clampPercent(40.9)).toBe(40);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(null)).toBeNull();
    expect(clampPercent(Number.NaN)).toBeNull();
  });

  it("describes progress as stage, percent, or both", () => {
    expect(progressLabel(job({ progressStage: "PARSE", progressPercent: 40 }))).toBe("PARSE · 40%");
    expect(progressLabel(job({ progressStage: "PARSE", progressPercent: null }))).toBe("PARSE");
    expect(progressLabel(job({ progressStage: null, progressPercent: 70 }))).toBe("70%");
    expect(progressLabel(job({ progressStage: null, progressPercent: null }))).toBe(
      "No progress reported",
    );
    expect(progressLabel(job({ progressStage: null, progressPercent: 250 }))).toBe("100%");
  });

  it("builds a complete view model per job", () => {
    expect(toJobView(job({ status: "running" }))).toMatchObject({
      statusLabel: "Running",
      progressLabel: "PARSE · 40%",
      clampedPercent: 40,
      canStop: true,
      canRetry: false,
    });
    expect(
      toJobView(job({ status: "failed", attempts: 1, errorMessage: "boom" })),
    ).toMatchObject({ canStop: false, canRetry: true });
    expect(toJobView(job({ status: "cancelled" }))).toMatchObject({
      canStop: false,
      canRetry: false,
    });
  });

  it("orders the drawer live-first, then by attempts", () => {
    const ordered = sortJobsForDrawer([
      job({ id: "s", status: "succeeded", attempts: 1 }),
      job({ id: "q", status: "queued", attempts: 0 }),
      job({ id: "f", status: "failed", attempts: 3 }),
      job({ id: "r", status: "running", attempts: 1 }),
      job({ id: "f2", status: "failed", attempts: 1 }),
    ]).map((j) => j.id);
    expect(ordered).toEqual(["r", "q", "f", "f2", "s"]);
  });

  it("counts live jobs and labels the shell indicator", () => {
    expect(runningCount([])).toBe(0);
    expect(runningCount([job({ status: "running" }), job({ status: "queued" })])).toBe(2);
    expect(runningCount([job({ status: "succeeded" }), job({ status: "failed" })])).toBe(0);
    expect(indicatorLabel([])).toBe("Background jobs: idle");
    expect(indicatorLabel([job({ status: "succeeded" })])).toBe("Background jobs: idle");
    expect(indicatorLabel([job({ status: "running" })])).toBe("Background jobs: 1 active");
    expect(indicatorLabel([job({ status: "running" }), job({ status: "queued" })])).toBe(
      "Background jobs: 2 active",
    );
  });
});
