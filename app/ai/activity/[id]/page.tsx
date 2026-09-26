import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";

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
      <main className="mx-auto max-w-3xl px-6 py-10">
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
  const evidenceText = analysis?.evidence ? JSON.stringify(analysis.evidence) : "";
  const evidencePreview = evidenceText.length > 2000 ? `${evidenceText.slice(0, 2000)}…` : evidenceText;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/ai/activity" className="text-sm underline">
        ← Activity
      </Link>
      <p className="mt-4 text-xs font-semibold uppercase text-muted-foreground">
        Deep Analysis · {job.status} · stage {job.stage}
      </p>
      <h1 className="mt-2 text-3xl font-semibold">{analysis?.title ?? "Financial review"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Started {new Date(job.created_at).toLocaleString()} · updated {new Date(job.updated_at).toLocaleString()}
      </p>
      {job.error && (
        <p role="alert" className="mt-4 rounded border p-3 text-sm text-red-700">
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
        <article className="mt-6 rounded border p-4">
          <p className="whitespace-pre-wrap text-sm">{truncate(analysis.body, 4000)}</p>
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
