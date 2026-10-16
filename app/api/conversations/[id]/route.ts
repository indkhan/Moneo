import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { conversationTitleSchema, loadConversation } from "@/lib/ai/conversation-history";

type Context = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "no-store" };

async function owned({ params }: Context) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Conversation unavailable" }, { status: 404 });
  try { return { id, context: await requireWorkspace() }; }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
}

export async function GET(request: Request, route: Context) {
  const found = await owned(route);
  if (found instanceof Response) return found;
  const { id, context } = found;
  try {
    return Response.json(await loadConversation(context.supabase, context.workspace.id, id, new URL(request.url).searchParams.get("messagesBefore") ?? undefined), { headers });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : "Could not load conversation" }, { status: 400, headers });
  }
}

export async function PATCH(request: Request, route: Context) {
  const found = await owned(route);
  if (found instanceof Response) return found;
  const { id, context } = found;
  const parsed = z.object({ title: conversationTitleSchema }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Enter a title of 1 to 120 characters" }, { status: 400 });
  const result = await context.supabase.from("conversations").update({ title: parsed.data.title })
    .eq("workspace_id", context.workspace.id).eq("id", id).is("deleted_at", null).select("id,title,created_at").maybeSingle();
  if (result.error) return Response.json({ error: "Could not rename conversation. Try again." }, { status: 500 });
  if (!result.data) return Response.json({ error: "Conversation unavailable" }, { status: 404 });
  return Response.json(result.data);
}

/** Soft delete: the chat leaves every list, while requests, audited edits and evidence stay intact. */
export async function DELETE(_request: Request, route: Context) {
  const found = await owned(route);
  if (found instanceof Response) return found;
  const { id, context } = found;
  const result = await context.supabase.from("conversations").update({ deleted_at: new Date().toISOString() })
    .eq("workspace_id", context.workspace.id).eq("id", id).is("deleted_at", null).select("id").maybeSingle();
  if (result.error) return Response.json({ error: "Could not delete conversation. Try again." }, { status: 500 });
  if (!result.data) return Response.json({ error: "Conversation unavailable" }, { status: 404 });
  return Response.json({ deleted: true });
}
