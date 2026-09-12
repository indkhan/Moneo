"use client";

import * as React from "react";
import { useState } from "react";
import { indicatorLabel, runningCount, type UiJob } from "../lib/jobs";
import { JobDrawer } from "./JobDrawer";

/**
 * Issue 2.8 — global running-job indicator.
 *
 * Lives in the app shell (layout mount). Shows the live-job count and opens
 * the detail drawer. Takes jobs + actions as props so data fetching
 * (Issues 2.9–2.10) plugs in without touching this file.
 */
export function JobIndicator({
  jobs = [],
  onStop,
  onRetry,
}: {
  jobs?: UiJob[];
  onStop?: (jobId: string) => void;
  onRetry?: (jobId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const live = runningCount(jobs);
  const busy = live > 0;

  return (
    <>
      <button
        type="button"
        id="job-indicator-mount"
        role="status"
        aria-label={indicatorLabel(jobs)}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          color: "var(--moneo-muted, #9aa7b8)",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 4,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: busy ? "#d29922" : "#3fb950",
            display: "inline-block",
          }}
        />
        {busy ? `${live} job${live === 1 ? "" : "s"} active` : "Jobs idle"}
      </button>
      {open ? (
        <JobDrawer
          jobs={jobs}
          onClose={() => {
            setOpen(false);
          }}
          onStop={onStop}
          onRetry={onRetry}
        />
      ) : null}
    </>
  );
}
