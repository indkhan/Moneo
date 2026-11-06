import type { requireWorkspace } from "@/lib/auth";
import { ArtifactFrame } from "@/components/artifact-frame";
import { CardView } from "@/components/cards/card-view";
import { cardScope } from "@/lib/cards/render";
import { loadPageVersion, renderPage } from "@/lib/ai/artifact-page";
import { artifactQueriesSchema, runArtifactQueries } from "@/lib/ai/artifact-data";
import { calendarDate } from "@/lib/finance/calendar";

export async function ArtifactPageContent({ id, title, version, context }: { id: string; title: string; version: number; context: Awaited<ReturnType<typeof requireWorkspace>> }) {
  const row = await loadPageVersion(context.supabase, context.workspace.id, id, version);
  if (!row) return <p role="alert" className="p-6">This Page version is unavailable.</p>;
  if (row.compiled) {
    const rendered = await renderPage(row, context);
    return <CardView page key={row.id} cardId={id} title={title} size="XL" {...rendered} scope={cardScope(id)} version={version} locale={context.workspace.locale} />;
  }
  const queries = artifactQueriesSchema.parse(row.queries);
  const data = await runArtifactQueries(queries, context, calendarDate(new Date(), context.settings.timezone));
  return <div className="space-y-4 p-4">
    <p role="status" className="text-sm text-muted-foreground">This older HTML design is view-only. Its scripts are disabled. Ask in the chat to rebuild the Page for live charts and controls; your saved design stays in version history.</p>
    <details open className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Current data</summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(data, null, 2)}</pre></details>
    <ArtifactFrame src={`/ai/artifacts/${id}/frame?v=${version}`} title={title} className="h-[600px] w-full" />
  </div>;
}
