import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { loadPageVersion, renderPage } from "@/lib/ai/artifact-page";

/** Only checked Page trees cross into the browser. Legacy HTML is served separately without scripts or live data. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = z.uuid().safeParse((await params).id);
  const search = new URL(request.url).searchParams;
  const version = z.coerce.number().int().min(1).optional().safeParse(search.get("v") ?? undefined);
  if (!id.success || !version.success) return Response.json({ error: "Not found" }, { status: 404 });
  const { supabase, workspace } = context;
  const { data: artifact, error } = await supabase.from("artifacts").select("id").eq("workspace_id", workspace.id).eq("id", id.data).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!artifact) return Response.json({ error: "Not found" }, { status: 404 });
  const row = await loadPageVersion(supabase, workspace.id, id.data, version.data);
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  const requested = Object.fromEntries([...search].filter(([key]) => key.startsWith("p.")).map(([key, value]) => [key.slice(2), value]));
  const body = row.compiled ? { ...await renderPage(row, context, requested), version: row.version, legacy: false } : { legacy: true, version: row.version };
  return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
}
