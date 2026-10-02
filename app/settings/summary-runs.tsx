"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

export type SummaryRun = { id: string; job_id: string; cadence: string; period_start: string; status: string; stage: string; error: string | null };

export function SummaryRuns({ initial }: { initial: SummaryRun[] }) {
  const [runs, setRuns] = useState(initial), [error, setError] = useState("");
  const active = runs.some(run => ["queued", "running"].includes(run.status));
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const timer = setInterval(async () => {
      const updated = await Promise.all(runs.map(async run => {
        if (!["queued", "running"].includes(run.status)) return run;
        try {
          const response = await fetch(`/api/analysis/${run.job_id}`);
          if (!response.ok) return run;
          const job = await response.json();
          return { ...run, status: job.status, stage: job.stage, error: job.error };
        } catch { return run; }
      }));
      if (mounted) setRuns(updated);
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
  return <div className="mt-4 space-y-3">
    {!runs.length && <p className="text-sm text-muted-foreground">No scheduled summaries yet.</p>}
    {runs.map(run => <div key={run.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3 text-sm">
      <div><p>{run.cadence} · period starting {run.period_start}</p><p className="text-muted-foreground">{run.status} · {run.stage}</p>
        {run.error && <p className="text-red-700">{run.error}</p>}
        {run.status === "completed" && <Link className="underline" href={`/ai/activity/${run.job_id}`}>Read summary</Link>}</div>
      {["queued", "running"].includes(run.status) && <button className="rounded border border-border px-3 py-1" disabled={run.stage === "stopping"} onClick={() => stop(run.job_id)}>{run.stage === "stopping" ? "Stopping…" : "Stop summary"}</button>}
    </div>)}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </div>;
}
