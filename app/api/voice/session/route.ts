import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { loadVoiceVocabulary } from "@/lib/ai/voice-vocabulary";
import { voiceApiKey } from "@/lib/ai/configured";
import { VOICE_NEEDS_OPENAI_KEY } from "@/lib/ai/voice-access";

const VOICE_MODEL = "gpt-live-transcribe";
const PROMPT = "A short personal-finance voice note: spending, income, transfers, amounts with currencies, and names of accounts, shops and categories.";
const inputSchema = z.object({}).strict();
const secretSchema = z.object({ value: z.string().min(1), expires_at: z.number() });

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!inputSchema.safeParse(await request.json().catch(() => null)).success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const apiKey = await voiceApiKey();
  if (!apiKey) return Response.json({ error: VOICE_NEEDS_OPENAI_KEY }, { status: 503 });
  const { supabase, workspace, settings } = context;
  const keywords = await loadVoiceVocabulary(supabase, workspace.id, settings.ai_data_scopes).catch(() => []);
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal: request.signal,
    body: JSON.stringify({
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
