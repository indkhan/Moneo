import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { reviewFreshness } from "@/lib/finance/review-freshness";
import { ReviewVerification } from "@/components/review-verification";
import { AiMessage } from "@/components/ai-message";
import { AutoRefresh } from "@/components/auto-refresh";

export const metadata = { title: "Saved review" };

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
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
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
          ← AI review history
        </Link>
        <p role="alert" className="mt-4 text-danger">
          Could not load this review. <Link href={`/ai/activity/${id}`} className="underline">Try again</Link>
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
  const when = (iso: string) => new Date(iso).toLocaleString(workspace.locale, { timeZone: workspace.timezone });
  const STATE: Record<string, string> = { queued: "Waiting to start", running: "In progress", completed: "Finished", failed: "Did not finish", canceled: "Stopped" };

  return (
    <main className="mx-auto max-w-5xl px-5 py-8 lg:px-8">
      <Link href="/ai/activity?filter=analyses" className="text-sm underline">
        ← AI review history
      </Link>
      <p className="mt-5 eyebrow">
        Financial review · {STATE[job.status] ?? "In progress"}
      </p>
      <h1 className="mt-2 page-title">{analysis?.title ?? "Financial review"}</h1>
      {evidence?.period && (
        <p className="mt-2 text-sm font-medium">
          Covers {evidence.period.from ?? "?"} to {evidence.period.to ?? "?"}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Started {when(job.created_at)} · updated {when(job.updated_at)}
      </p>
      {job.error && (
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Technical details</summary>
          <p className="mt-1 break-words">{truncate(job.error, 500)}</p>
        </details>
      )}
      {analysisError && (
        <p role="alert" className="mt-4 text-sm text-danger">
          Could not load the saved review. Reload to try again.
        </p>
      )}
      {!analysis && job.status === "completed" && !analysisError && (
        <p className="mt-4 text-muted-foreground">This review finished but its report is not available. Reload in a moment. If it stays missing, <Link className="underline" href="/ai">run a new review</Link>; reloading never starts one.</p>
      )}
      {job.status === "failed" || job.status === "canceled" ? (
        <p className="mt-4 text-muted-foreground">
          This review did not finish and will not continue. <Link className="underline" href="/ai">Run a new review</Link>; that uses a new AI request.
        </p>
      ) : !analysis && job.status !== "completed" && (
        <p role="status" className="mt-4 text-muted-foreground">
          Still working. This page updates by itself.<AutoRefresh />
        </p>
      )}
      {analysis && (
        <article className="mt-6 rounded-xl border border-border bg-card p-5 shadow-sm">
          {freshness?.status === "current"
            ? <p className="text-sm text-muted-foreground">Saved {when(analysis.created_at)} · Evidence {freshness.status}: {freshness.reason}</p>
            : <div className="rounded-lg border border-warning bg-warning-soft p-3 text-sm"><p className="font-medium">Saved {when(analysis.created_at)} · Evidence {freshness?.status}: {freshness?.reason}</p><p className="mt-1">This report is kept as it was written. <Link className="underline" href="/ai">Run a new review</Link> for current figures.</p></div>}
          <ReviewVerification evidence={analysis.evidence} from={`/ai/activity/${id}`} />
          <div className="mt-3 text-sm"><AiMessage content={analysis.body} /></div>
          {!!analysis.evidence && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm underline">Technical details (raw evidence)</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(analysis.evidence, null, 2)}</pre>
            </details>
          )}
        </article>
      )}
    </main>
  );
}
