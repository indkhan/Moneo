import { SPEECH_ENGINES, type SpeechEngineId } from "@/lib/settings";
import { VOICE_NEEDS_OPENAI_KEY } from "@/lib/ai/voice-access";
import { SPEECH_ENGINE_LABELS, type BatchSpeechEngines, type SpeechAudio, type SpeechHints } from "./engine";

export type SpeechAvailability = Record<SpeechEngineId, boolean>;
export type SpeechChoice = { engine: SpeechEngineId; fellBack: boolean } | { engine: null; reason: string };
export type SpeechResult =
  | { ok: true; text: string; engine: SpeechEngineId; fellBack: boolean }
  | { ok: false; reason: string; status: 502 | 503 };

const withoutFallback = (chosen: SpeechEngineId) => chosen === "openai" ? VOICE_NEEDS_OPENAI_KEY
  : `${SPEECH_ENGINE_LABELS[chosen]} is not available, and there is no OpenAI API key to fall back to. Add an OpenAI key in Settings or choose another speech-to-text engine.`;

export function chooseSpeechEngine(chosen: SpeechEngineId, available: SpeechAvailability): SpeechChoice {
  if (available[chosen]) return { engine: chosen, fellBack: false };
  return available.openai ? { engine: "openai", fellBack: true } : { engine: null, reason: withoutFallback(chosen) };
}

export async function speechAvailability(engines: BatchSpeechEngines): Promise<SpeechAvailability> {
  const entries = await Promise.all(SPEECH_ENGINES.map(async id => [id, await (engines[id]?.available().catch(() => false) ?? false)] as const));
  return Object.fromEntries(entries) as SpeechAvailability;
}

export async function transcribeWithFallback({ chosen, engines, audio, hints, signal }: {
  chosen: SpeechEngineId; engines: BatchSpeechEngines; audio: SpeechAudio; hints: SpeechHints; signal?: AbortSignal;
}): Promise<SpeechResult> {
  const available = await speechAvailability(engines);
  const choice = chooseSpeechEngine(chosen, available);
  if (!choice.engine) return { ok: false, reason: choice.reason, status: 503 };
  const attempt = (engine: SpeechEngineId) => engines[engine]!.transcribe(audio, hints, signal).then(text => text.trim(), () => {
    console.warn("[speech] engine-failed", engine);
    return null;
  });
  const failed: SpeechResult = { ok: false, reason: "Voice input is unavailable. Try again.", status: 502 };
  const first = await attempt(choice.engine);
  if (first !== null) return { ok: true, text: first, engine: choice.engine, fellBack: choice.fellBack };
  if (choice.engine === "openai" || !available.openai) return failed;
  const second = await attempt("openai");
  return second === null ? failed : { ok: true, text: second, engine: "openai", fellBack: true };
}
