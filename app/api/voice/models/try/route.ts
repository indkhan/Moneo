import { requireWorkspace } from "@/lib/auth";
import { decodeSpeechAudio, MAX_SPEECH_BYTES } from "@/lib/ai/speech/audio";
import { loadSpeechHints } from "@/lib/ai/speech/hints";
import { transcribeLocally } from "@/lib/ai/speech/local";
import { workerRunner } from "@/lib/ai/speech/local-runner";
import { localSpeechSupported, resolveModel } from "@/lib/ai/speech/model-store";
import { logWarn } from "@/lib/log";

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!localSpeechSupported()) return Response.json({ error: "Speech to text on this computer isn't available for this processor yet." }, { status: 503 });
  const query = new URL(request.url).searchParams;
  const ref = query.get("model")?.trim() || null;
  if (!await resolveModel(ref)) return Response.json({ error: "Download this model or choose a folder with a Whisper or Moonshine model first." }, { status: 409 });
  if (Number(request.headers.get("content-length")) > MAX_SPEECH_BYTES) return Response.json({ error: "Recording is too long" }, { status: 413 });
  const audio = decodeSpeechAudio(request.headers.get("content-type"), query.get("rate"), new Uint8Array(await request.arrayBuffer()));
  if (!audio) return Response.json({ error: "Invalid audio" }, { status: 400 });
  const { supabase, workspace, settings } = context;
  const hints = await loadSpeechHints(supabase, workspace.id, settings.ai_data_scopes);
  const started = performance.now();
  try {
    const text = (await transcribeLocally(ref, workerRunner, audio, hints)).trim();
    return Response.json({ text, seconds: Math.round((performance.now() - started) / 100) / 10 }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logWarn("voice", "speech_local_try_failed", "[speech] local-try-failed", cause instanceof Error ? cause.message : cause);
    return Response.json({ error: "The model could not transcribe this recording. Check that the folder holds a complete Whisper or Moonshine model." }, { status: 502 });
  }
}
