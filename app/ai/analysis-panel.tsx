"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {resolveReviewRequest, type ReviewRequest} from "@/lib/finance/review-request";
import type {ReviewProgress} from "@/lib/finance/review-controller";
import {calendarDate} from "@/lib/finance/calendar";
import type { ReviewFreshness } from "@/lib/finance/review-freshness";
import { AiMessage } from "@/components/ai-message";
import { ReviewVerification } from "@/components/review-verification";

type Review = { id: string; created_at?: string; status: string; stage: string; cancel_requested?: boolean; error: string | null; review_request?: ReviewRequest; review_progress?: ReviewProgress; analysis?: { title: string; body: string; evidence: unknown; created_at: string; freshness: ReviewFreshness } | null };

const label = (value: string) => { const text = value.replaceAll("_", " "); return text[0].toUpperCase() + text.slice(1); };

/** The first thing wrong with the dates: a half-filled or reversed range. Blank ranges are fine. */
export function datesProblem(value: (name: string) => string) {
  for (const [from, to, label] of [["from", "to", "Review period"], ["comparisonFrom", "comparisonTo", "Compare with"]] as const) {
    if (!value(from) && !value(to)) continue;
    if (!value(from)) return { field: from, message: `${label}: enter a start date as well.` };
    if (!value(to)) return { field: to, message: `${label}: enter an end date as well.` };
    if (value(from) > value(to)) return { field: to, message: `${label}: the end date is before the start date.` };
  }
  return null;
}

export function AnalysisPanel({ locale, timezone }: { locale: string; timezone: string }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [jobs, setJobs] = useState<Review[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lost, setLost] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    fetch("/api/analysis").then(response => { if (!response.ok) throw new Error(); return response.json(); }).then((jobs: Review[]) => {
      if (Array.isArray(jobs)) { setJobs(jobs); if (jobs[0]) setJobId(jobs[0].id); }
    }).catch(() => setError("Could not load your past reviews. You can still start a new one."));
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    async function refresh() {
      // A failed check keeps the last known status and tries again on the next tick.
      try {
        const response = await fetch(`/api/analysis/${jobId}`);
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (active) { setReview(data); setLost(false); }
      } catch { if (active) setLost(true); }
    }
    void refresh();
    const timer = setInterval(() => { if (review?.status === "queued" || review?.status === "running") void refresh(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [jobId, review?.status, attempt]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const problem = datesProblem(name => String(fields.get(name) ?? "").trim());
    if (problem) { setError(problem.message); (event.currentTarget.elements.namedItem(problem.field) as HTMLElement | null)?.focus(); return; }
    setBusy(true); setError("");
    try {
      const text = (name: string) => String(fields.get(name) ?? "").trim();
      const planning = text("planning");
      const selected = resolveReviewRequest({version: 1, question: text("question"), focus: text("focus"), output: text("output"),
        ...(planning === "goals" ? {planningViews: [{view: "goals"}]} : planning === "7" || planning === "30" ? {planningViews: [{view: "forecast", input: {horizonDays: Number(planning)}}]} : {})}, calendarDate(new Date(), timezone));
      const investigation = {...selected, query: {...selected.query,
        ...(text("from") || text("to") ? {period: {from: text("from"), to: text("to")}, comparison: undefined} : {}),
        ...(text("comparisonFrom") || text("comparisonTo") ? {comparison: {from: text("comparisonFrom"), to: text("comparisonTo")}} : {})}};
      const response = await fetch("/api/analysis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), investigation }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not start review");
      setJobId(data.jobId); setReview({ id: data.jobId, status: data.status, stage: data.status, error: null, review_request: investigation });
      setJobs(current => [{ id: data.jobId, created_at: new Date().toISOString(), status: data.status, stage: data.status, error: null }, ...current.filter(job => job.id !== data.jobId)].slice(0, 20));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start review"); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!jobId) return;
    const response = await fetch(`/api/analysis/${jobId}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) setError("Could not stop this review. Try again.");
    else { const data = await response.json(); setReview(current => current && (data.status === "cancel_requested"
      ? { ...current, cancel_requested: true, stage: "cancel_requested" }
      : { ...current, status: data.status, stage: data.status })); }
  }

  return <section className="p-5 sm:p-6"><h2 className="text-sm font-medium text-foreground">Deep Financial Analysis</h2>
    <p className="mt-1 text-sm text-muted-foreground">A saved, evidence-checked review of a period you choose. It takes longer than a chat answer, uses an AI request, and only starts when you press Run review.</p>
    <form onSubmit={start} className="mt-4 grid gap-3">
      <label className="grid gap-1 text-sm">What would you like to investigate?<textarea name="question" required maxLength={2000} defaultValue="Review my finances" className="rounded-lg border border-border bg-background p-2" /></label>
      <label className="grid gap-1 text-sm">Focus (optional)<input name="focus" maxLength={500} placeholder="For example, subscriptions" className="rounded-lg border border-border bg-background p-2" /></label>
      <fieldset className="grid gap-2 sm:grid-cols-2"><legend className="mb-2 text-sm">Review period (optional)</legend>
        <label className="grid gap-1 text-sm">From<input name="from" type="date" className="rounded-lg border border-border bg-background p-2" /></label>
        <label className="grid gap-1 text-sm">Through<input name="to" type="date" className="rounded-lg border border-border bg-background p-2" /></label>
      </fieldset>
      <fieldset className="grid gap-2 sm:grid-cols-2"><legend className="mb-2 text-sm">Compare with (optional)</legend>
        <label className="grid gap-1 text-sm">Comparison from<input name="comparisonFrom" type="date" className="rounded-lg border border-border bg-background p-2" /></label>
        <label className="grid gap-1 text-sm">Comparison through<input name="comparisonTo" type="date" className="rounded-lg border border-border bg-background p-2" /></label>
      </fieldset>
      <p className="text-sm text-muted-foreground">Leave dates blank to compare this month so far with the same part of last month.</p>
      <label className="text-sm">Result<select name="output" className="ml-2 rounded-lg border border-border bg-background p-2"><option value="answer">Focused answer</option><option value="report">Saved report</option></select></label>
      <label className="text-sm">Planning evidence (optional)<select name="planning" className="ml-2 rounded-lg border border-border bg-background p-2"><option value="">Spending only</option><option value="goals">Goals</option><option value="7">7-day forecast</option><option value="30">30-day forecast</option></select></label>
      <button type="submit" disabled={busy} className="justify-self-start rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">{busy ? "Starting…" : "Run review"}</button>
    </form>
    {jobs.length > 0 && <label className="mt-4 block text-sm">Saved reviews<select aria-label="Saved reviews" value={jobId ?? ""} onChange={event => { setReview(null); setJobId(event.target.value); }} className="ml-2 max-w-full rounded-lg border border-border bg-background p-2">{jobs.map(job => <option key={job.id} value={job.id}>{job.created_at ? `${new Date(job.created_at).toLocaleString(locale, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" })} · ` : ""}{label(job.status)}</option>)}</select>{jobs.length === 20 && <Link href="/ai/activity?filter=analyses" className="ml-2 underline">Older reviews</Link>}</label>}
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    {lost && <p role="alert" className="mt-3 text-sm text-danger">Could not check this review. It may still be running. <button type="button" onClick={() => setAttempt(count => count + 1)} className="underline">Check again</button></p>}
    {review && <div className="mt-4"><p role="status" className="text-sm">{review.cancel_requested && ["queued", "running"].includes(review.status) ? "Stop requested. Waiting for active work to finish stopping." : label(review.status)}</p>
      {review.review_request && <p className="mt-2 text-sm">{review.review_request.question} · {review.review_request.query.period.from} through {review.review_request.query.period.to}</p>}
      {review.review_progress && <div className="mt-2 text-sm text-muted-foreground"><p>Evidence checks {review.review_progress.queries.length}/{review.review_progress.request.budget.maxQueries} · Supporting records {review.review_progress.supportRecords}/{review.review_progress.request.budget.maxSupportRecords}</p>
        {review.review_progress.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}
      </div>}
      {review.error && <p role="alert" className="text-sm text-danger">{review.error}</p>}
      {["queued", "running"].includes(review.status) && !review.cancel_requested && <button onClick={cancel} className="mt-2 text-sm underline">Stop</button>}
      {review.status === "canceled" && <p className="mt-2 text-sm text-muted-foreground">{review.stage === "cancellation_unconfirmed" ? "Stop requested. The runtime ended, but request termination could not be confirmed." : "Application work stopped."} Completed edits remain in history. A provider may already have processed submitted data.</p>}
      {review.analysis && <p className="mt-3 text-sm text-muted-foreground">Saved {new Date(review.analysis.created_at).toLocaleString(locale, { timeZone: timezone })} · Data {label(review.analysis.freshness.status).toLowerCase()}: {review.analysis.freshness.reason}</p>}
      {review.analysis && <ReviewVerification evidence={review.analysis.evidence} />}
      {review.analysis && <article className="mt-4"><h3 className="font-semibold">{review.analysis.title}</h3><div className="mt-2"><AiMessage content={review.analysis.body} /></div><details className="mt-3 rounded-lg border border-border bg-muted p-3"><summary className="cursor-pointer text-xs">Technical details (raw evidence)</summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(review.analysis.evidence, null, 2)}</pre></details></article>}
    </div>}
  </section>;
}
