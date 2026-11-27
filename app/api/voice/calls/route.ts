import { after } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { modelForSettings } from "@/lib/ai/provider";
import { VOICE_CALL_TITLE } from "@/lib/ai/voice-access";
import { MAX_RECORD_BYTES, callRecordSchema, summarizeCall } from "@/lib/ai/voice-call-record";

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_RECORD_BYTES) return Response.json({ error: "Call record is too large" }, { status: 413 });
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { json = null; }
  const parsed = callRecordSchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: "Invalid call record" }, { status: 400 });
  const { id, workspaceId, conversationId, durationSeconds, transcript, tasks } = parsed.data;
  const { supabase, workspace, settings } = context;
  if (workspaceId !== workspace.id) return Response.json({ error: "This call record belongs to a different workspace" }, { status: 409 });
  const conversation = await supabase.from("conversations").select("id, deleted_at").eq("workspace_id", workspace.id).eq("id", conversationId).maybeSingle();
  if (conversation.error) throw conversation.error;
  if (conversation.data?.deleted_at) return Response.json({ error: "Conversation unavailable" }, { status: 404 });
  if (!conversation.data) {
    const created = await supabase.from("conversations").insert({ id: conversationId, workspace_id: workspace.id, title: VOICE_CALL_TITLE });
    if (created.error && created.error.code !== "23505") throw created.error;
  }
  const saved = await supabase.from("voice_calls").insert({ id, workspace_id: workspace.id, conversation_id: conversationId, duration_seconds: durationSeconds, transcript, tasks, request_ids: tasks.map(task => task.requestId) });
  if (saved.error?.code === "23505") {
    const existing = await supabase.from("voice_calls").select("id").eq("workspace_id", workspace.id).eq("id", id).maybeSingle();
    if (existing.error) throw existing.error;
    return existing.data ? Response.json({ id }) : Response.json({ error: "Call id is already used" }, { status: 409 });
  }
  if (saved.error) throw saved.error;
  after(() => summarizeCall(supabase, { workspaceId: workspace.id, callId: id, conversationId, transcript, model: () => modelForSettings(settings, "chat", { workspaceId: workspace.id, task: "voice_summary", conversationId }) }));
  return Response.json({ id }, { status: 201 });
}
