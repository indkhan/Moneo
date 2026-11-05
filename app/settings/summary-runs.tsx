"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { displayFormat } from "@/lib/display-format";

export type SummaryRun = { id: string; job_id: string; cadence: string; period_start: string; status: string; stage: string; error: string | null };

const STALE_AFTER_FAILED_POLLS = 3;

export function SummaryRuns({ initial, locale }: { initial: SummaryRun[]; locale: string }) {
  const [runs, setRuns] = useState(initial), [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const failures = useRef(0);
  const active = runs.some(run => ["queued", "running"].includes(run.status));
  const { date } = displayFormat(locale);
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const timer = setInterval(async () => {
      let failed = false;
      const updated = await Promise.all(runs.map(async run => {
        if (!["queued", "running"].includes(run.status)) return run;
        try {
          const response = await fetch(`/api/analysis/${run.job_id}`);
          if (!response.ok) { failed = true; return run; }
          const job = await response.json();
          return { ...run, status: job.status, stage: job.stage, error: job.error };
        } catch { failed = true; return run; }
      }));
      if (!mounted) return;
      failures.current = failed ? failures.current + 1 : 0;
      setStale(failures.current >= STALE_AFTER_FAILED_POLLS);
      setRuns(updated);
    }, 5000);
    return () => { mounted = false; clearInterval(timer); };
  }, [runs, active]);
  async function stop(jobId: string) {
    try {
      const response = await fetch(`/api/analysis/${jobId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Summary could not be stopped");
      setRuns(current => current.map(run => run.job_id === jobId ? { ...run, stage: "stopping" } : run));
    } catch { setError("Summary could not be stopped; try again"); }
  }
  return <div className="mt-4 divide-y divide-border">
    {!runs.length && <p className="text-sm text-muted-foreground">No scheduled summaries yet.</p>}
    {stale && <p role="alert" className="pb-3 text-sm text-warning">Could not check for updates, so the status below may be out of date. Moneo keeps trying; <button type="button" onClick={() => location.reload()} className="underline">reload</button> to check now.</p>}
    {runs.map(run => <div key={run.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm first:pt-0">
      <div><p className="font-medium"><span className="capitalize">{run.cadence}</span> · from {date(run.period_start)}</p><p aria-live="polite" className="text-muted-foreground capitalize">{run.status} · {run.stage.replaceAll("_", " ")}</p>
        {run.error && <div className="text-danger"><p>This summary could not finish. Your data was not changed.</p><details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer">Technical details</summary><p className="mt-1 break-words">{run.error}</p></details></div>}
        {run.status === "completed" && <Link className="underline" href={`/ai/activity/${run.job_id}`}>Read summary</Link>}</div>
      {["queued", "running"].includes(run.status) && <button className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted" disabled={run.stage === "stopping"} onClick={() => stop(run.job_id)}>{run.stage === "stopping" ? "Stopping…" : "Stop summary"}</button>}
    </div>)}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
