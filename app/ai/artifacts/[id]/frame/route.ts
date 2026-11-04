import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { ARTIFACT_FRAME_CSP, artifactDocument, artifactQueriesSchema, runArtifactQueries } from "@/lib/ai/artifact-data";
import { calendarDate } from "@/lib/finance/calendar";

const querySchema = z.object({
  v: z.coerce.number().int().min(1).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

/**
 * The artifact page on its own URL, so pages that show it (gallery previews, the viewer) render at once and
 * each frame reruns its saved queries for today.
 */
// Shown inside the sandboxed frame, so it is plain and needs nothing from the app.
const problem = (message: string, status: number) => new Response(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:24px;color:#555">${message}</body>`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return problem("Your session has ended. Sign in again, then reopen this page.", 401); }
  const id = z.uuid().safeParse((await params).id);
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!id.success || !query.success) return problem("This page could not be found.", 404);
  const { supabase, workspace } = context;
  const { v, theme } = query.data;
  const versions = supabase.from("artifact_versions").select("html, queries").eq("workspace_id", workspace.id).eq("artifact_id", id.data);
  const [artifact, version] = await Promise.all([
    supabase.from("artifacts").select("id").eq("workspace_id", workspace.id).eq("id", id.data).is("deleted_at", null).maybeSingle(),
    (v ? versions.eq("version", v) : versions.order("version", { ascending: false }).limit(1)).maybeSingle(),
  ]);
  if (artifact.error || version.error) return problem("This page could not load. Reload to try again.", 500);
  if (!artifact.data || !version.data) return problem("This page could not be found.", 404);
  const queries = artifactQueriesSchema.safeParse(version.data.queries);
  const data = await runArtifactQueries(queries.success ? queries.data : [], context, calendarDate(new Date(), context.settings.timezone));
  return new Response(artifactDocument(version.data.html, data, { theme }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": ARTIFACT_FRAME_CSP, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
