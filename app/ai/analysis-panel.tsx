"use client";

import { useEffect, useState } from "react";

type Review = { id: string; status: string; stage: string; error: string | null; analysis?: { title: string; body: string; evidence: unknown } | null };

export function AnalysisPanel() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/analysis").then(response => response.json()).then((jobs: Review[]) => {
      if (Array.isArray(jobs) && jobs[0]) setJobId(jobs[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    async function refresh() {
      const response = await fetch(`/api/analysis/${jobId}`);
      const data = await response.json();
      if (active) setReview(data);
    }
    void refresh();
    const timer = setInterval(() => { if (review?.status === "queued" || review?.status === "running") void refresh(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [jobId, review?.status]);

  async function start() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/analysis", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not start review");
      setJobId(data.jobId); setReview({ id: data.jobId, status: "queued", stage: "queued", error: null });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start review"); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!jobId) return;
    const response = await fetch(`/api/analysis/${jobId}`, { method: "DELETE" });
    if (!response.ok) setError("Could not stop review");
    else setReview(current => current && { ...current, stage: "stopping" });
  }

  return <section className="mt-10 rounded border p-5"><h2 className="text-xl font-semibold">Deep Financial Analysis</h2>
    <p className="mt-1 text-sm text-muted-foreground">A saved review based on exact current financial evidence.</p>
    <button onClick={start} disabled={busy} className="mt-4 rounded bg-primary px-4 py-2 text-sm text-primary-foreground">{busy ? "Starting…" : "Run review"}</button>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {review && <div className="mt-4"><p className="text-sm">{review.status} · {review.stage}</p>
      {review.error && <p role="alert" className="text-sm text-red-700">{review.error}</p>}
      {["queued", "running"].includes(review.status) && <button onClick={cancel} className="mt-2 text-sm underline">Stop</button>}
      {review.analysis && <article className="mt-4"><h3 className="font-semibold">{review.analysis.title}</h3><p className="mt-2 whitespace-pre-wrap text-sm">{review.analysis.body}</p><details className="mt-3"><summary className="text-sm underline">Evidence</summary><pre className="overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(review.analysis.evidence, null, 2)}</pre></details></article>}
    </div>}
  </section>;
}
