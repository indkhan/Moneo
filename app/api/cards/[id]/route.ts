import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { loadCardVersion, renderCard } from "@/lib/cards/render";
import { cardSize } from "@/lib/cards/sizes";

const querySchema = z.object({ v: z.coerce.number().int().min(1).optional(), size: z.string().optional() });

/** One card rendered for a param change or another size: the published version, or a draft version when asked. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = z.uuid().safeParse((await params).id);
  const search = new URL(request.url).searchParams;
  const query = querySchema.safeParse({ v: search.get("v") ?? undefined, size: search.get("size") ?? undefined });
  if (!id.success || !query.success) return Response.json({ error: "Not found" }, { status: 404 });
  const { supabase, workspace } = context;
  const card = await supabase.from("artifact_cards").select("id, size, published_version").eq("workspace_id", workspace.id).eq("id", id.data).is("deleted_at", null).maybeSingle();
  if (card.error) throw card.error;
  const shown = query.data.v ?? card.data?.published_version;
  if (!card.data || !shown) return Response.json({ error: "Not found" }, { status: 404 });
  const version = await loadCardVersion(supabase, workspace.id, id.data, shown);
  if (!version) return Response.json({ error: "Not found" }, { status: 404 });
  const requested = Object.fromEntries([...search].filter(([key]) => key.startsWith("p.")).map(([key, value]) => [key.slice(2), value]));
  const rendered = await renderCard(version, context, { size: cardSize(query.data.size ?? card.data.size), requested });
  return Response.json(rendered, { headers: { "Cache-Control": "private, no-store" } });
}
