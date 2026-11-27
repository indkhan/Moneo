import type { SpeechEngineId, WorkspaceSettings } from "@/lib/settings";
import type { BatchSpeechEngines } from "./engine";
import { localSpeech } from "./local";
import { workerRunner } from "./local-runner";
import { OPENAI_SPEECH_MODEL, openaiSpeech } from "./openai";
import { openrouterSpeech } from "./openrouter";

export const batchEngines = (settings: Pick<WorkspaceSettings, "speech_local_model" | "speech_openrouter_model">): BatchSpeechEngines => ({
  openai: openaiSpeech,
  local: localSpeech(settings.speech_local_model, workerRunner),
  openrouter: openrouterSpeech(settings.speech_openrouter_model),
});

export function speechModelId(engine: SpeechEngineId, settings: Pick<WorkspaceSettings, "speech_local_model" | "speech_openrouter_model">): string {
  switch (engine) {
    case "openai": return OPENAI_SPEECH_MODEL;
    case "local": return settings.speech_local_model ?? "local";
    case "openrouter": return settings.speech_openrouter_model ?? "openrouter";
  }
}
