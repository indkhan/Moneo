import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { VOICES } from "@/lib/settings";
import { voiceApiKey } from "@/lib/ai/configured";
import { VOICE_NEEDS_OPENAI_KEY } from "@/lib/ai/voice-access";
import { outcomeOf, recordUsage, type UsageOutcome } from "@/lib/ai/usage-ledger";
import { log, logError } from "@/lib/log";

const querySchema = z.object({ voice: z.enum(VOICES) }).strict();
const SPEECH_MODEL = "gpt-4o-mini-tts";
const SAMPLE_LINE = "Hey, it's Moneo. Want me to check your spending?";
const clips = new Map<string, Promise<ArrayBuffer>>();

function makeClip(voice: string, apiKey: string, workspaceId: string) {
  const started = performance.now();
  const record = (outcome: UsageOutcome) => void recordUsage({ workspaceId, task: "text_to_speech" },
    { modelId: SPEECH_MODEL, source: "openai", durationMs: performance.now() - started, tokens: null, audioSeconds: null, outcome });
  return fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: SPEECH_MODEL, voice, input: SAMPLE_LINE, response_format: "mp3" }),
  }).then(response => { if (!response.ok) throw Object.assign(new Error(`speech ${response.status}`), { statusCode: response.status }); return response.arrayBuffer(); })
    .then(clip => {
      record({ status: "succeeded" });
      log({ level: "info", area: "voice", event: "text_to_speech", message: `Spoke the ${voice} voice sample`, details: { model: SPEECH_MODEL, voice, text: SAMPLE_LINE }, workspaceId, audio: { bytes: clip, contentType: "audio/mpeg" } });
      return clip;
    }, (error: unknown) => { record(outcomeOf(error)); throw error; });
}

export async function GET(request: Request) {
  let workspaceId: string;
  try { workspaceId = (await requireWorkspace()).workspace.id; } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "Unknown voice" }, { status: 400 });
  const apiKey = await voiceApiKey();
  if (!apiKey) return Response.json({ error: VOICE_NEEDS_OPENAI_KEY }, { status: 503 });
  const { voice } = parsed.data;
  if (!clips.has(voice)) clips.set(voice, makeClip(voice, apiKey, workspaceId));
  try {
    return new Response(await clips.get(voice)!, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" } });
  } catch (error) {
    clips.delete(voice);
    logError("voice", "voice_sample_failed", "voice sample failed", error);
    return Response.json({ error: "Could not play the sample" }, { status: 502 });
  }
}
