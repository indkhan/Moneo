import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { LOG_AUDIO_BUCKET } from "@/lib/logs/options";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return Response.json({ error: "Unknown log entry" }, { status: 404 });
  const { supabase, workspace } = context;
  const { data } = await supabase.from("app_logs").select("audio_path").eq("workspace_id", workspace.id).eq("id", id.data).maybeSingle();
  if (!data?.audio_path) return Response.json({ error: "No audio for this entry" }, { status: 404 });
  const file = await supabase.storage.from(LOG_AUDIO_BUCKET).download(data.audio_path);
  if (file.error) return Response.json({ error: "The audio is no longer stored" }, { status: 404 });
  return new Response(file.data, { headers: { "Content-Type": file.data.type || "application/octet-stream", "Cache-Control": "private, no-store" } });
}
