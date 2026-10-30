import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { loadVoiceVocabulary } from "@/lib/ai/voice-vocabulary";

// The live model streams words while the user speaks and accepts a prompt and keywords; it has no server VAD,
// so the browser commits the audio when the user stops.
const VOICE_MODEL = "gpt-live-transcribe";
const PROMPT = "A short personal-finance voice note: spending, income, transfers, amounts with currencies, and names of accounts, shops and categories.";
const inputSchema = z.object({}).strict();
const secretSchema = z.object({ value: z.string().min(1), expires_at: z.number() });

/** A short-lived OpenAI realtime transcription secret, so the browser streams audio without the server's key. */
export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!inputSchema.safeParse(await request.json().catch(() => null)).success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Response.json({ error: "Voice isn't set up on this server: OPENAI_API_KEY is missing" }, { status: 503 });
  const { supabase, workspace, settings } = context;
  // Spelling hints only: a failed lookup still lets the user talk.
  const keywords = await loadVoiceVocabulary(supabase, workspace.id, settings.ai_data_scopes).catch(() => []);
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal: request.signal,
    body: JSON.stringify({
      // Only opening the connection needs the secret; an unused one is worthless within a minute.
      expires_after: { anchor: "created_at", seconds: 60 },
      session: { type: "transcription", audio: { input: {
        format: { type: "audio/pcm", rate: 24000 }, noise_reduction: { type: "near_field" }, turn_detection: null,
        transcription: { model: VOICE_MODEL, prompt: PROMPT, ...(keywords.length && { keywords }) },
      } } },
    }),
  }).catch(() => null);
  const secret = secretSchema.safeParse(await response?.json().catch(() => null));
  if (!response?.ok || !secret.success) return Response.json({ error: "Voice input is unavailable. Try again." }, { status: 502 });
  return Response.json({ token: secret.data.value, expiresAt: secret.data.expires_at, url: "wss://api.openai.com/v1/realtime?intent=transcription" }, { headers: { "Cache-Control": "no-store" } });
}
