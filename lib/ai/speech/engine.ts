import type { SpeechEngineId } from "@/lib/settings";

export const SPEECH_ENGINE_LABELS: Record<SpeechEngineId, string> = { openai: "OpenAI", local: "On this computer", openrouter: "OpenRouter" };

export type SpeechAudio = { samples: Int16Array; sampleRate: number };
export type SpeechHints = { prompt: string; keywords: string[] };

export type BatchSpeechEngine = {
  available: () => Promise<boolean>;
  transcribe: (audio: SpeechAudio, hints: SpeechHints, signal?: AbortSignal) => Promise<string>;
  interim?: (audio: SpeechAudio, hints: SpeechHints) => Promise<string | null>;
};
export type BatchSpeechEngines = Partial<Record<SpeechEngineId, BatchSpeechEngine>>;

export type SpeechPlan = { mode: "live"; fellBack: boolean } | { mode: "batch"; engine: SpeechEngineId; fellBack: false; live: boolean };
