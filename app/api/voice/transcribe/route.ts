import { requireWorkspace } from "@/lib/auth";
import { decodeSpeechAudio, MAX_SPEECH_BYTES } from "@/lib/ai/speech/audio";
import { transcribeWithFallback } from "@/lib/ai/speech/choose";
import { loadSpeechHints } from "@/lib/ai/speech/hints";
import { batchEngines } from "@/lib/ai/speech/registry";

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (Number(request.headers.get("content-length")) > MAX_SPEECH_BYTES) return Response.json({ error: "Recording is too long" }, { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  const audio = decodeSpeechAudio(request.headers.get("content-type"), new URL(request.url).searchParams.get("rate"), bytes);
  if (!audio) return Response.json({ error: "Invalid audio" }, { status: bytes.byteLength > MAX_SPEECH_BYTES ? 413 : 400 });
  const { supabase, workspace, settings } = context;
  const hints = await loadSpeechHints(supabase, workspace.id, settings.ai_data_scopes);
  const result = await transcribeWithFallback({ chosen: settings.speech_engine, engines: batchEngines, audio, hints, signal: request.signal });
  if (!result.ok) return Response.json({ error: result.reason }, { status: result.status });
  return Response.json({ text: result.text, engine: result.engine, fellBack: result.fellBack }, { headers: { "Cache-Control": "no-store" } });
}
