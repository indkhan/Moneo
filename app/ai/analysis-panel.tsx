"use client";

import { useEffect, useState } from "react";
import type { ReviewFreshness } from "@/lib/finance/review-freshness";
import { AiMessage } from "@/components/ai-message";
import { ReviewVerification } from "@/components/review-verification";

type Review = { id: string; status: string; stage: string; cancel_requested?: boolean; error: string | null; analysis?: { title: string; body: string; evidence: unknown; created_at: string; freshness: ReviewFreshness } | null };

export function AnalysisPanel({ locale, timezone }: { locale: string; timezone: string }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [jobs, setJobs] = useState<Review[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/analysis").then(response => response.json()).then((jobs: Review[]) => {
      if (Array.isArray(jobs)) { setJobs(jobs); if (jobs[0]) setJobId(jobs[0].id); }
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
      const response = await fetch("/api/analysis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not start review");
      setJobId(data.jobId); setReview({ id: data.jobId, status: data.status, stage: data.status, error: null });
      setJobs(current => [{ id: data.jobId, status: data.status, stage: data.status, error: null }, ...current.filter(job => job.id !== data.jobId)].slice(0, 20));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start review"); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!jobId) return;
    const response = await fetch(`/api/analysis/${jobId}`, { method: "DELETE" });
    if (!response.ok) setError("Could not stop review");
    else { const data = await response.json(); setReview(current => current && (data.status === "cancel_requested"
      ? { ...current, cancel_requested: true, stage: "cancel_requested" }
      : { ...current, status: data.status, stage: data.status })); }
  }

  return <section className="mt-10 rounded-xl border border-border bg-card p-5 shadow-sm"><h2 className="text-xl font-semibold tracking-tight text-foreground">Deep Financial Analysis</h2>
    <p className="mt-1 text-sm text-muted-foreground">A saved review of dated financial evidence. Its findings reflect the saved review period.</p>
    <button onClick={start} disabled={busy} className="mt-4 rounded-lg bg-brand px-4 py-2 font-medium text-white hover:opacity-90 text-sm">{busy ? "Starting…" : "Run review"}</button>
    {jobs.length > 1 && <label className="ml-3 text-sm">Saved reviews<select aria-label="Saved reviews" value={jobId ?? ""} onChange={event => { setReview(null); setJobId(event.target.value); }} className="ml-2 rounded border p-2">{jobs.map(job => <option key={job.id} value={job.id}>{job.id.slice(0, 8)} · {job.status}</option>)}</select></label>}
    {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    {review && <div className="mt-4"><p role="status" className="text-sm">{review.cancel_requested && ["queued", "running"].includes(review.status) ? "Stop requested. Waiting for active work to finish stopping." : `${review.status} · ${review.stage}`}</p>
      {review.error && <p role="alert" className="text-sm text-red-300">{review.error}</p>}
      {["queued", "running"].includes(review.status) && !review.cancel_requested && <button onClick={cancel} className="mt-2 text-sm underline">Stop</button>}
      {review.status === "canceled" && <p className="mt-2 text-sm text-muted-foreground">{review.stage === "cancellation_unconfirmed" ? "Stop requested. The runtime ended, but request termination could not be confirmed." : "Application work stopped."} Completed edits remain in history. A provider may already have processed submitted data.</p>}
      {review.analysis && <p className="mt-3 text-sm text-muted-foreground">Saved {new Date(review.analysis.created_at).toLocaleString(locale, { timeZone: timezone })} · Evidence {review.analysis.freshness.status}: {review.analysis.freshness.reason}</p>}
      {review.analysis && <ReviewVerification evidence={review.analysis.evidence} />}
      {review.analysis && <article className="mt-4"><h3 className="font-semibold">{review.analysis.title}</h3><div className="mt-2"><AiMessage content={review.analysis.body} /></div><details className="mt-3 rounded-lg border border-border bg-muted p-3"><summary className="cursor-pointer font-mono text-xs">Evidence</summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(review.analysis.evidence, null, 2)}</pre></details></article>}
    </div>}
  </section>;
}
