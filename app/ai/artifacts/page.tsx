import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { artifactExamples } from "@/lib/ai/artifact-examples";
import { ArtifactPrompt } from "./artifact-prompt";

export default async function ArtifactsPage({ searchParams }: { searchParams: Promise<{ prompt?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const { prompt } = await searchParams;
  const { data, error } = await supabase.from("artifacts").select("id, title, updated_at")
    .eq("workspace_id", workspace.id).is("deleted_at", null).order("updated_at", { ascending: false }).limit(200);
  const date = new Intl.DateTimeFormat(workspace.locale, { dateStyle: "medium", timeZone: workspace.timezone });
  return <main className="mx-auto grid max-w-5xl gap-8 p-4 sm:p-8">
    <header className="grid gap-1">
      <h1 className="text-2xl font-semibold">Artifacts</h1>
      <p className="text-sm text-muted-foreground">Interactive pages built from your real data. They refresh every time you open them and never change your records.</p>
    </header>
    <section aria-label="New artifact" className="rounded-xl border border-border bg-card p-4">
      <ArtifactPrompt key={prompt} defaultValue={prompt?.slice(0, 4000)} placeholder="Describe what to build, e.g. “What if my rent goes up €300 — how does my monthly budget look?”" />
    </section>
    <section aria-label="Examples" className="grid gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">Start from an example</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{artifactExamples.map(example => <li key={example.title}>
        <Link href={`/ai/artifacts?prompt=${encodeURIComponent(example.prompt)}`} scroll={false} className="block h-full rounded-xl border border-border bg-card p-4 hover:bg-muted">
          <span className="block font-medium">{example.title}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{example.summary}</span>
        </Link></li>)}</ul>
    </section>
    {error ? <p role="alert">Could not load artifacts.</p> : !data.length ? <p className="text-sm text-muted-foreground">No artifacts yet.</p> :
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.map(artifact => <li key={artifact.id}>
        <Link href={`/ai/artifacts/${artifact.id}`} className="block h-full rounded-xl border border-border bg-card p-4 hover:bg-muted">
          <span className="block font-medium">{artifact.title}</span>
          <span className="mt-1 block text-xs text-muted-foreground">Updated {date.format(new Date(artifact.updated_at))}</span>
        </Link></li>)}</ul>}
  </main>;
}
