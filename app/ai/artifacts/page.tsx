import Link from "next/link";
import { z } from "zod";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { ArtifactPreview } from "./artifact-preview";
import { artifactExamples } from "@/lib/ai/artifact-examples";
import { ArtifactExamples, ArtifactPrompt } from "./artifact-prompt";
import { DeleteArtifactButton } from "./delete-artifact-button";

export const metadata = { title: "Artifacts" };

// Match chat's recovery window: older running requests were interrupted.
const runningSince = () => new Date(Date.now() - 6 * 60_000).toISOString();

export default async function ArtifactsPage({ searchParams }: { searchParams: Promise<{ prompt?: string; q?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/setup"); }
  const { supabase, workspace } = context;
  const { prompt, q: rawQuery } = await searchParams;
  const q = z.string().trim().max(100).catch("").parse(rawQuery ?? "");
  const gallery = supabase.from("artifacts").select("id, title, updated_at, artifact_versions(prompt), conversations(id)")
    .eq("workspace_id", workspace.id).is("deleted_at", null).eq("artifact_versions.version", 1);
  const { data, error } = await (q ? gallery.ilike("title", `%${q.replace(/[\\%_]/g, "\\$&")}%`) : gallery).order("updated_at", { ascending: false }).limit(200);
  const conversationIds = (data ?? []).flatMap(artifact => artifact.conversations.map(chat => chat.id));
  const requests = conversationIds.length ? await supabase.from("chat_requests").select("conversation_id")
    .eq("workspace_id", workspace.id).in("conversation_id", conversationIds).eq("status", "running")
    .gt("created_at", runningSince()) : null;
  // Only the Building label depends on this, so a failure here must not take the gallery down with it.
  const running = new Set(requests?.data?.map(request => request.conversation_id));
  const date = new Intl.DateTimeFormat(workspace.locale, { dateStyle: "medium", timeZone: workspace.timezone });
  return <main className="mx-auto grid w-full max-w-[1400px] gap-8 px-4 py-6 sm:px-8 lg:py-8">
    <header className="grid gap-1">
      <p className="eyebrow">Built from your data</p>
      <h1 className="page-title">Artifacts</h1>
      <p className="text-sm text-muted-foreground">Custom reports and tools built from your real data, each with its own chat and optional cards for Home. They refresh every time you open them and never change your records.</p>
    </header>
    <section aria-label="New artifact" className="rounded-xl border border-border bg-card p-4">
      <ArtifactPrompt key={prompt} defaultValue={prompt?.slice(0, 4000)} placeholder="Describe what to build, e.g. “What if my rent goes up €300 — how does my monthly budget look?”" />
    </section>
    <section aria-labelledby="saved-artifacts" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="saved-artifacts" className="font-display text-2xl font-semibold tracking-tight">Your artifacts{data?.length ? <span className="ml-1 font-sans text-sm font-normal text-muted-foreground">({data.length})</span> : null}</h2>
        {(q || (data?.length ?? 0) > 6) && <form role="search" action="/ai/artifacts" className="flex gap-2"><label className="sr-only" htmlFor="artifact-search">Search artifacts by title</label><input id="artifact-search" type="search" name="q" defaultValue={q} maxLength={100} placeholder="Search titles" className="min-h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm" /><button className="min-h-10 rounded-lg border border-border px-3 text-sm hover:bg-muted">Search</button></form>}
      </div>
      {data?.length === 200 && <p className="text-xs text-muted-foreground">Showing the 200 most recently updated. Search to find older ones.</p>}
    {error ? <p role="alert" className="text-sm">Could not load your artifacts. You can still build a new one. <Link href="/ai/artifacts" className="underline">Try again</Link></p> : !data.length ? <p className="text-sm text-muted-foreground">{q ? <>No artifact title matches “{q}”. <Link href="/ai/artifacts" className="underline">Show all</Link></> : "No artifacts yet."}</p> :
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.map(artifact => <li key={artifact.id} className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card hover:bg-muted">
        <ArtifactPreview id={artifact.id} title={artifact.title} hasPage={!!artifact.artifact_versions.length} building={artifact.conversations.some(chat => running.has(chat.id))} />
        <div className="flex items-start gap-2 border-t border-border p-4">
          <div className="min-w-0 flex-1">
            {/* The stretched link makes the whole card clickable while the delete button stays its own control. */}
            <Link href={`/ai/artifacts/${artifact.id}`} className="block font-medium after:absolute after:inset-0 after:rounded-xl">{artifact.title}</Link>
            {/* The original request says what the artifact is for. */}
            {artifact.artifact_versions[0]?.prompt && <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">{artifact.artifact_versions[0].prompt}</span>}
            <span className="mt-1 block text-xs text-muted-foreground">Updated {date.format(new Date(artifact.updated_at))}</span>
          </div>
          <DeleteArtifactButton id={artifact.id} title={artifact.title} label="" className="relative z-10 -m-1 p-1" />
        </div></li>)}</ul>}
    </section>
    {/* Open for a first visit; returning users come for their saved work. */}
    <details open={!data?.length || undefined} aria-label="Examples">
      <summary className="min-h-10 cursor-pointer py-2 text-sm font-medium text-muted-foreground hover:text-foreground">Browse examples <span className="font-normal">(these fill the prompt; nothing runs until you press Build)</span></summary>
      <div className="mt-2"><ArtifactExamples examples={artifactExamples} /></div>
    </details>
  </main>;
}
