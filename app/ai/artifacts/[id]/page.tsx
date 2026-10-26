import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { artifactDocument, artifactQueriesSchema, runArtifactQueries } from "@/lib/ai/artifact-data";
import { ArtifactPrompt } from "../artifact-prompt";
import { DeleteArtifactButton } from "../delete-artifact-button";

export default async function ArtifactPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string; full?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const [{ id }, { v, full }] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [artifact, versions] = await Promise.all([
    supabase.from("artifacts").select("id, title").eq("workspace_id", workspace.id).eq("id", id).is("deleted_at", null).maybeSingle(),
    supabase.from("artifact_versions").select("version, prompt, html, queries").eq("workspace_id", workspace.id).eq("artifact_id", id).order("version"),
  ]);
  if (artifact.error || versions.error) throw artifact.error ?? versions.error;
  if (!artifact.data || !versions.data.length) notFound();
  const current = versions.data.find(item => String(item.version) === v) ?? versions.data.at(-1)!;
  const latest = versions.data.at(-1)!.version;
  // Saved queries rerun on every open, so the page always shows today's data.
  const queries = artifactQueriesSchema.safeParse(current.queries);
  const data = await runArtifactQueries(queries.success ? queries.data : [], context);
  const frame = <iframe title={artifact.data.title} sandbox="allow-scripts" srcDoc={artifactDocument(current.html, data)} className="size-full border-0" />;
  const at = (version: number, fullScreen = !!full) => `/ai/artifacts/${id}?v=${version}${fullScreen ? "&full=1" : ""}`;

  if (full) return <div className="fixed inset-0 z-50 bg-background">
    {frame}
    <Link href={at(current.version, false)} aria-label="Exit full screen" className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-lg border border-border bg-card/90 px-3 py-1.5 text-xs shadow hover:bg-muted">
      <Minimize2 className="size-3.5" aria-hidden="true" />Exit</Link>
  </div>;

  return <main className="grid gap-4 p-4 lg:h-[calc(100dvh-1rem)] lg:grid-cols-[minmax(300px,380px)_1fr]">
    <aside className="flex min-h-0 flex-col gap-4">
      <div>
        <Link href="/ai/artifacts" className="text-xs text-muted-foreground hover:underline">← Artifacts</Link>
        <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight">{artifact.data.title}</h1>
      </div>
      <ol aria-label="Versions" className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto">
        {versions.data.map(item => <li key={item.version}>
          <Link href={at(item.version)} aria-current={item.version === current.version ? "page" : undefined}
            className="block rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted aria-[current=page]:border-primary aria-[current=page]:bg-muted">
            <span className="text-xs text-muted-foreground">v{item.version}</span> {item.prompt}</Link></li>)}
      </ol>
      <ArtifactPrompt artifactId={id} placeholder="Change something, e.g. “Add a toggle for selling the car”" />
      <DeleteArtifactButton id={id} title={artifact.data.title} />
    </aside>
    <section aria-label="Artifact" className="flex min-h-[70dvh] flex-col overflow-hidden rounded-xl border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-1.5 text-xs">
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
          {current.version > 1 ? <Link href={at(current.version - 1)} aria-label="Previous version" className="rounded p-1 hover:bg-muted"><ChevronLeft className="size-3.5" /></Link> : <span className="p-1 opacity-30"><ChevronLeft className="size-3.5" /></span>}
          v{current.version} of {latest}
          {current.version < latest ? <Link href={at(current.version + 1)} aria-label="Next version" className="rounded p-1 hover:bg-muted"><ChevronRight className="size-3.5" /></Link> : <span className="p-1 opacity-30"><ChevronRight className="size-3.5" /></span>}
        </span>
        <span className="hidden truncate text-muted-foreground xl:inline">Live data · read-only · what-ifs are estimates</span>
        <Link href={at(current.version, true)} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-1 hover:bg-muted"><Maximize2 className="size-3.5" aria-hidden="true" />Full screen</Link>
      </div>
      <div className="min-h-0 flex-1">{frame}</div>
    </section>
  </main>;
}
