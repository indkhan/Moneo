import { requireWorkspace } from "@/lib/auth";
import { decodeSpeechAudio, MAX_SPEECH_BYTES } from "@/lib/ai/speech/audio";
import { loadSpeechHints } from "@/lib/ai/speech/hints";
import { batchEngines } from "@/lib/ai/speech/registry";

const noStore = { headers: { "Cache-Control": "no-store" } };

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (Number(request.headers.get("content-length")) > MAX_SPEECH_BYTES) return Response.json({ error: "Recording is too long" }, { status: 413 });
  const { supabase, workspace, settings } = context;
  const engine = batchEngines(settings)[settings.speech_engine];
  if (!engine?.interim) return Response.json({ error: "This speech-to-text engine has no live words" }, { status: 409 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  const audio = decodeSpeechAudio(request.headers.get("content-type"), new URL(request.url).searchParams.get("rate"), bytes);
  if (!audio) return Response.json({ error: "Invalid audio" }, { status: bytes.byteLength > MAX_SPEECH_BYTES ? 413 : 400 });
  const hints = await loadSpeechHints(supabase, workspace.id, settings.ai_data_scopes);
  let text: string | null;
  try { text = await engine.interim(audio, hints); } catch { return Response.json({ error: "Live words are unavailable" }, { status: 502 }); }
  return Response.json(text === null ? { busy: true } : { text: text.trim() }, noStore);
}
