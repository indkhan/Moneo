import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { chooseSpeechEngine, speechAvailability } from "@/lib/ai/speech/choose";
import { loadSpeechHints } from "@/lib/ai/speech/hints";
import { batchEngines } from "@/lib/ai/speech/registry";
import { voiceApiKey } from "@/lib/ai/configured";
import { jsonBodyOrNull } from "@/lib/json-body";
import { recordVoiceUsage } from "@/lib/ai/voice-usage-server";
import { qaMockAi } from "@/lib/env";

const VOICE_MODEL = "gpt-live-transcribe";
const inputSchema = z.object({}).strict();
const secretSchema = z.object({ value: z.string().min(1), expires_at: z.number() });

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!inputSchema.safeParse(await jsonBodyOrNull(request)).success) return Response.json({ error: "Invalid request" }, { status: 400 });
  if (qaMockAi()) return Response.json({ mode: "batch", fellBack: false, live: false }, { headers: { "Cache-Control": "no-store" } });
  const { supabase, workspace, settings } = context;
  const engines = batchEngines(settings);
  const choice = chooseSpeechEngine(settings.speech_engine, await speechAvailability(engines));
  if (!choice.engine) return Response.json({ error: choice.reason }, { status: 503 });
  if (choice.engine !== "openai") return Response.json({ mode: "batch", engine: choice.engine, fellBack: false, live: Boolean(engines[choice.engine]?.interim) }, { headers: { "Cache-Control": "no-store" } });
  const apiKey = await voiceApiKey();
  if (!apiKey) return Response.json({ error: "Voice input is unavailable. Try again." }, { status: 502 });
  const hints = await loadSpeechHints(supabase, workspace.id, settings.ai_data_scopes);
  const started = performance.now();
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal: request.signal,
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: { type: "transcription", audio: { input: {
        format: { type: "audio/pcm", rate: 24000 }, noise_reduction: { type: "near_field" }, turn_detection: null,
        transcription: { model: VOICE_MODEL, prompt: hints.prompt, ...(hints.keywords.length && { keywords: hints.keywords }) },
      } } },
    }),
  }).catch(() => null);
  const secret = secretSchema.safeParse(await response?.json().catch(() => null));
  const failed = !response?.ok || !secret.success;
  const usageId = await recordVoiceUsage({ workspaceId: workspace.id, task: "voice_transcription" }, { modelId: VOICE_MODEL, source: "openai", durationMs: performance.now() - started, tokens: null, audioSeconds: null,
    outcome: failed ? { status: "failed", error: { statusCode: response?.status ?? 0 } } : { status: "succeeded" } });
  if (failed) return Response.json({ error: "Voice input is unavailable. Try again." }, { status: 502 });
  return Response.json({ mode: "live", fellBack: choice.fellBack, token: secret.data.value, expiresAt: secret.data.expires_at, usageId, url: "wss://api.openai.com/v1/realtime?intent=transcription" }, { headers: { "Cache-Control": "no-store" } });
}
