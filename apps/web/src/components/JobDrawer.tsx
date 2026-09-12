"use client";

import * as React from "react";
import { sortJobsForDrawer, toJobView, type UiJob } from "../lib/jobs";

/**
 * Issue 2.8 — job detail drawer.
 *
 * Lists every known durable job with its progress stage, a real
 * `progressbar` (screen readers announce percent), a Stop control for live
 * jobs, and Retry exactly when the job failed with budget left. Pure render
 * over props: no fetching, no timers.
 */
export function JobDrawer({
  jobs,
  onClose,
  onStop,
  onRetry,
}: {
  jobs: UiJob[];
  onClose: () => void;
  onStop?: (jobId: string) => void;
  onRetry?: (jobId: string) => void;
}) {
  const views = sortJobsForDrawer(jobs).map(toJobView);

  return (
    <div role="dialog" aria-modal="false" aria-label="Background jobs" id="job-detail-drawer">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 14, margin: 0 }}>Background jobs</h2>
        <button type="button" aria-label="Close job details" onClick={onClose}>
          Close
        </button>
      </div>
      {views.length === 0 ? (
        <p>No background jobs yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {views.map((job) => (
            <li
              key={job.id}
              aria-label={`Job ${job.type} ${job.statusLabel}`}
              style={{ padding: "8px 0", borderTop: "1px solid #eee" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong>{job.type}</strong>
                <span>{job.statusLabel}</span>
              </div>
              <div style={{ fontSize: 12, color: "#666" }}>{job.progressLabel}</div>
              {job.clampedPercent !== null ? (
                <div
                  role="progressbar"
                  aria-label={`${job.type} progress`}
                  aria-valuenow={job.clampedPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              ) : null}
              <div>
                {job.attempts} of {job.maxAttempts} attempts
              </div>
              {job.errorMessage && job.status === "failed" ? (
                <div role="alert" style={{ fontSize: 12, color: "#a00" }}>
                  {job.errorMessage}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  aria-label={`Stop ${job.type}`}
                  disabled={!job.canStop}
                  onClick={() => {
                    onStop?.(job.id);
                  }}
                >
                  Stop
                </button>
                {job.canRetry ? (
                  <button
                    type="button"
                    aria-label={`Retry ${job.type}`}
                    onClick={() => {
                      onRetry?.(job.id);
                    }}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
