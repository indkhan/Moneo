import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { VOICE_INSTRUCTIONS, VOICE_MODEL, seedInput } from "@/lib/ai/voice-call";

const inputSchema = z.object({ sdp: z.string().min(1).max(20_000), conversationId: z.uuid() }).strict();

/** Starts a GPT-Live WebRTC session for the browser's offer; the API key stays on the server. */
export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid call request" }, { status: 400 });
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "Voice isn't set up on this server: OPENAI_API_KEY is missing" }, { status: 503 });
  const { sdp, conversationId } = parsed.data;
  const { supabase, workspace, settings } = context;
  const existing = await supabase.from("conversations").select("id, deleted_at").eq("workspace_id", workspace.id).eq("id", conversationId).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.deleted_at) return Response.json({ error: "Conversation was deleted" }, { status: 404 });
  // A new chat has no row yet; its first call request creates it.
  let history: { role: string; content: string }[] = [];
  if (existing.data) {
    const { data, error } = await supabase.from("messages").select("role, content").eq("workspace_id", workspace.id).eq("conversation_id", conversationId)
      .order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    history = (data ?? []).reverse();
  }
  try {
    const session = await openai.experimental_realtime(VOICE_MODEL).doCreateWebRTCSession({ sdp, abortSignal: request.signal, sessionConfig: {
      instructions: VOICE_INSTRUCTIONS, voice: settings.voice,
      providerOptions: { openai: { delegation: { type: "client" }, input: seedInput(history) } },
    } });
    return Response.json({ sdp: session.sdp, sessionId: session.sessionId });
  } catch (error) {
    console.error("voice session failed", error);
    return Response.json({ error: "Could not start the call" }, { status: 502 });
  }
}
