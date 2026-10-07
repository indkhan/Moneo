import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { reviewFreshness } from "@/lib/finance/review-freshness";
import { ReviewVerification } from "@/components/review-verification";
import { AiMessage } from "@/components/ai-message";

function truncate(value: string | null | undefined, max = 280) {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export default async function AnalysisActivityDetail({ params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/login");
  }
  const { id } = await params;
  const { supabase, workspace } = context;
  const { data: job, error: jobError } = await supabase
    .from("background_jobs")
    .select("id, status, stage, error, created_at, updated_at")
    .eq("workspace_id", workspace.id)
    .eq("kind", "financial_review")
    .eq("id", id)
    .maybeSingle();
  if (jobError) {
    return (
      <main className="mx-auto max-w-5xl px-5 py-8 lg:px-8">
        <Link href="/ai/activity" className="text-sm underline">
          ← Activity
        </Link>
        <p role="alert" className="mt-4 text-red-700">
          Could not load this analysis: {truncate(jobError.message, 200)}
        </p>
      </main>
    );
  }
  if (!job) notFound();
  const { data: analysis, error: analysisError } = job.status === "completed"
    ? await supabase
        .from("saved_analyses")
        .select("id, title, body, evidence, created_at")
        .eq("workspace_id", workspace.id)
        .eq("job_id", id)
        .maybeSingle()
    : { data: null, error: null };
  const evidence = analysis?.evidence as { period?: { from?: string; to?: string } } | null;
  const freshness = analysis ? await reviewFreshness(supabase, workspace, analysis.evidence) : null;
  const evidenceText = analysis?.evidence ? JSON.stringify(analysis.evidence) : "";
  const evidencePreview = evidenceText.length > 2000 ? `${evidenceText.slice(0, 2000)}…` : evidenceText;

  return (
    <main className="mx-auto max-w-5xl px-5 py-8 lg:px-8">
      <Link href="/ai/activity" className="text-sm underline">
        ← Activity
      </Link>
      <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-brand">
        Deep Analysis · {job.status} · stage {job.stage}
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{analysis?.title ?? "Financial review"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Started {new Date(job.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })} · updated {new Date(job.updated_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}
      </p>
      {job.error && (
        <p role="alert" className="mt-4 rounded-xl border border-border bg-card p-4 shadow-sm text-sm text-red-700">
          {truncate(job.error, 500)}
        </p>
      )}
      {analysisError && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          Could not load the saved review: {truncate(analysisError.message, 200)}
        </p>
      )}
      {!analysis && job.status === "completed" && !analysisError && (
        <p className="mt-4 text-muted-foreground">The completed review has no saved analysis yet.</p>
      )}
      {!analysis && job.status !== "completed" && (
        <p className="mt-4 text-muted-foreground">
          This review has not completed. Track progress from <Link className="underline" href="/ai">AI</Link>.
        </p>
      )}
      {analysis && (
        <article className="mt-6 rounded-xl border border-border bg-card p-5 shadow-sm">
          <p className="text-sm text-muted-foreground">Saved {new Date(analysis.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })} · Evidence {freshness?.status}: {freshness?.reason}</p>
          <ReviewVerification evidence={analysis.evidence} />
          <div className="mt-3 text-sm"><AiMessage content={analysis.body} /></div>
          {evidence?.period && (
            <p className="mt-3 text-sm text-muted-foreground">
              Evidence period {evidence.period.from ?? "?"} to {evidence.period.to ?? "?"}
            </p>
          )}
          {evidencePreview && (
            <details className="mt-3">
              <summary className="text-sm underline">Evidence summary</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">{evidencePreview}</pre>
            </details>
          )}
        </article>
      )}
    </main>
  );
}
