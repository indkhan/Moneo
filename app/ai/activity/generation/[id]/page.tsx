import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { usageLabel, type ReportedUsage } from "@/lib/ai/usage";
import { GenerationActions } from "./generation-actions";

export default async function GenerationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, workspace } = await requireWorkspace();
  const { data, error } = await supabase.from("artifact_generation_requests").select("id, artifact_id, purpose, description, status, result, error, usage, created_at, updated_at")
    .eq("workspace_id", workspace.id).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) notFound();
  const artifact = data.artifact_id ? await supabase.from("artifacts").select("active_version_id")
    .eq("workspace_id", workspace.id).eq("id", data.artifact_id).maybeSingle() : null;
  if (artifact?.error) throw artifact.error;
  return <main className="mx-auto max-w-5xl space-y-4 p-6"><Link href="/ai/activity" className="underline">Activity</Link>
    <h1 className="text-2xl font-semibold">{data.purpose === "calculator" ? "Calculator draft" : "Tool proposal"}</h1>
    <p>{data.status} · {new Date(data.updated_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}</p>
    <p className="text-sm text-muted-foreground">{usageLabel(data.usage as ReportedUsage | null)}</p>
    <p className="whitespace-pre-wrap">{data.description}</p>
    {data.error && <p role="alert" className="text-red-700">{data.error}</p>}
    <p className="text-sm text-muted-foreground">This is a retained proposal. Review its code and permissions before saving a calculator version or creating a tool.</p>
    {data.result && <pre className="max-h-[40rem] overflow-auto whitespace-pre-wrap rounded border p-4 text-xs">{JSON.stringify(data.result, null, 2)}</pre>}
    <GenerationActions id={id} artifactId={data.artifact_id} purpose={data.purpose} status={data.status} result={data.result} activeVersionId={artifact?.data?.active_version_id ?? null} />
    {data.artifact_id && <Link href={`/ai/library/${data.artifact_id}`} className="block underline">Open tool and version history</Link>}
  </main>;
}
