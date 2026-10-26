import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { ARTIFACT_FRAME_CSP, artifactDocument, artifactQueriesSchema, runArtifactQueries } from "@/lib/ai/artifact-data";

const querySchema = z.object({
  v: z.coerce.number().int().min(1).optional(),
  view: z.enum(["page", "widget"]).default("page"),
  theme: z.enum(["light", "dark"]).optional(),
});

/**
 * The artifact document on its own URL, so pages that show artifacts (gallery previews, Home cards,
 * the viewer) render at once and each frame reruns its saved queries in parallel.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const id = z.uuid().safeParse((await params).id);
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!id.success || !query.success) return new Response("Not found", { status: 404 });
  const { supabase, workspace } = context;
  const { v, view, theme } = query.data;
  const versions = supabase.from("artifact_versions").select("html, queries").eq("workspace_id", workspace.id).eq("artifact_id", id.data);
  const [artifact, version] = await Promise.all([
    supabase.from("artifacts").select("id").eq("workspace_id", workspace.id).eq("id", id.data).is("deleted_at", null).maybeSingle(),
    (v ? versions.eq("version", v) : versions.order("version", { ascending: false }).limit(1)).maybeSingle(),
  ]);
  if (artifact.error || version.error) throw artifact.error ?? version.error;
  if (!artifact.data || !version.data) return new Response("Not found", { status: 404 });
  const queries = artifactQueriesSchema.safeParse(version.data.queries);
  const data = await runArtifactQueries(queries.success ? queries.data : [], context);
  return new Response(artifactDocument(version.data.html, data, { view, theme }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": ARTIFACT_FRAME_CSP, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
