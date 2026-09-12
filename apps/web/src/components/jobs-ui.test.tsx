import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobDrawer } from "./JobDrawer";
import { JobIndicator } from "./JobIndicator";
import type { UiJob } from "../lib/jobs";

/**
 * Issue 2.8 — job status markup. No browser is needed: components render to
 * static HTML and every requirement (indicator, drawer, stage, Stop, Retry
 * eligibility, accessibility roles) is asserted on the markup. (`createElement`
 * instead of JSX because this repo compiles JSX via Next, not vitest.)
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

const noop = (): void => {};

describe("job status ui", () => {
  it("indicates idle with no live jobs", () => {
    const html = renderToStaticMarkup(h(JobIndicator, { jobs: [] }));
    expect(html).toContain('aria-label="Background jobs: idle"');
    expect(html).toContain("Jobs idle");
    expect(html).not.toContain("job-detail-drawer");
  });

  it("indicates the live count and keeps the shell mount id", () => {
    const html = renderToStaticMarkup(
      h(JobIndicator, {
        jobs: [job({ id: "a", status: "running" }), job({ id: "b", status: "queued" })],
      }),
    );
    expect(html).toContain('aria-label="Background jobs: 2 active"');
    expect(html).toContain("2 jobs active");
    expect(html).toContain('id="job-indicator-mount"');
  });

  it("drawer lists jobs live-first with stage and attempt counts", () => {
    const html = renderToStaticMarkup(
      h(JobDrawer, {
        jobs: [
          job({
            id: "s",
            type: "report.build",
            status: "succeeded",
            progressStage: null,
            progressPercent: null,
            attempts: 1,
          }),
          job({ id: "r", type: "import.process", status: "running", attempts: 1 }),
        ],
        onClose: noop,
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Background jobs"');
    const runningAt = html.indexOf("import.process");
    const doneAt = html.indexOf("report.build");
    expect(runningAt).toBeLessThan(doneAt);
    expect(html).toContain("PARSE · 40%");
    expect(html).toContain("1 of 5 attempts");
  });

  it("drawer shows an empty state with no jobs", () => {
    const html = renderToStaticMarkup(h(JobDrawer, { jobs: [], onClose: noop }));
    expect(html).toContain("No background jobs yet.");
  });

  it("exposes progress as an aria progressbar with the clamped value", () => {
    const html = renderToStaticMarkup(
      h(JobDrawer, {
        jobs: [job({ progressStage: "PARSE", progressPercent: 250 })],
        onClose: noop,
      }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="100"');
    const noPercent = renderToStaticMarkup(
      h(JobDrawer, {
        jobs: [job({ progressStage: "PARSE", progressPercent: null })],
        onClose: noop,
      }),
    );
    expect(noPercent).not.toContain('role="progressbar"');
    expect(noPercent).toContain("PARSE");
  });

  it("enables Stop for live jobs and disables it for terminal jobs", () => {
    const live = renderToStaticMarkup(
      h(JobDrawer, { jobs: [job({ status: "running" })], onClose: noop }),
    );
    expect(live).toContain('aria-label="Stop import.process"');
    expect(live).not.toMatch(/aria-label="Stop import\.process"[^>]*disabled/);
    const terminal = renderToStaticMarkup(
      h(JobDrawer, { jobs: [job({ status: "succeeded" })], onClose: noop }),
    );
    expect(terminal).toMatch(/disabled/);
  });

  it("shows Retry exactly when the job failed with budget left", () => {
    const retryable = renderToStaticMarkup(
      h(JobDrawer, {
        jobs: [job({ status: "failed", attempts: 2, errorMessage: "boom" })],
        onClose: noop,
      }),
    );
    expect(retryable).toContain('aria-label="Retry import.process"');
    expect(retryable).toContain("boom");
    const exhausted = renderToStaticMarkup(
      h(JobDrawer, {
        jobs: [job({ status: "failed", attempts: 5, errorMessage: "boom" })],
        onClose: noop,
      }),
    );
    expect(exhausted).not.toContain("Retry import.process");
    const running = renderToStaticMarkup(
      h(JobDrawer, { jobs: [job({ status: "running" })], onClose: noop }),
    );
    expect(running).not.toContain("Retry import.process");
  });

  it("announces failures as alerts but stays quiet for live jobs", () => {
    const failed = renderToStaticMarkup(
      h(JobDrawer, {
        jobs: [job({ status: "failed", errorMessage: "disk full" })],
        onClose: noop,
      }),
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("disk full");
    const live = renderToStaticMarkup(
      h(JobDrawer, { jobs: [job({ status: "running", errorMessage: "stale" })], onClose: noop }),
    );
    expect(live).not.toContain('role="alert"');
  });
});
