import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { conversationWords, writeTitle } from "@/lib/ai/chat-title";
import { modelForSettings } from "@/lib/ai/provider";

/** Writes a new title when the owner asks for one, even over a rename: asking is their choice. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Conversation unavailable" }, { status: 404 });
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const { supabase, workspace, settings } = context;
  const words = await conversationWords(supabase, workspace.id, id).catch(() => "");
  if (!words) return Response.json({ error: "This chat has nothing to name yet." }, { status: 400 });
  const written = await writeTitle(() => modelForSettings(settings, "titles"), words);
  if (!written) return Response.json({ error: "Could not write a title. Try again." }, { status: 502 });
  const result = await supabase.from("conversations").update({ title: written.title, title_settled: true })
    .eq("workspace_id", workspace.id).eq("id", id).is("deleted_at", null).select("id").maybeSingle();
  if (result.error) return Response.json({ error: "Could not save the title. Try again." }, { status: 500 });
  if (!result.data) return Response.json({ error: "Conversation unavailable" }, { status: 404 });
  return Response.json({ title: written.title });
}
