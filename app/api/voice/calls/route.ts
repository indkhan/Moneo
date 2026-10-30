import { after } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { modelForSettings } from "@/lib/ai/provider";
import { MAX_RECORD_BYTES, callRecordSchema, summarizeCall } from "@/lib/ai/voice-call-record";

/** Saves a finished call in its conversation; the summary is written afterwards, not before this answers. */
export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_RECORD_BYTES) return Response.json({ error: "Call record is too large" }, { status: 413 });
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* rejected by the schema below */ }
  const parsed = callRecordSchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: "Invalid call record" }, { status: 400 });
  const { id, conversationId, durationSeconds, transcript, tasks } = parsed.data;
  const { supabase, workspace, settings } = context;
  const conversation = await supabase.from("conversations").select("id, deleted_at").eq("workspace_id", workspace.id).eq("id", conversationId).maybeSingle();
  if (conversation.error) throw conversation.error;
  if (conversation.data?.deleted_at) return Response.json({ error: "Conversation unavailable" }, { status: 404 });
  // A call in a new chat that never asked anything has no conversation row yet.
  if (!conversation.data) {
    const title = (transcript.find(turn => turn.role === "user") ?? transcript[0]).text.slice(0, 80);
    const created = await supabase.from("conversations").insert({ id: conversationId, workspace_id: workspace.id, title });
    if (created.error && created.error.code !== "23505") throw created.error;
  }
  const saved = await supabase.from("voice_calls").insert({ id, workspace_id: workspace.id, conversation_id: conversationId, duration_seconds: durationSeconds, transcript, tasks, request_ids: tasks.map(task => task.requestId) });
  // A retry of the same call is already saved and already being summarized.
  if (saved.error?.code === "23505") return Response.json({ id });
  if (saved.error) throw saved.error;
  after(() => summarizeCall(supabase, { workspaceId: workspace.id, callId: id, transcript, model: () => modelForSettings(settings, "chat") }));
  return Response.json({ id }, { status: 201 });
}
