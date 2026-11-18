import type { WorkspaceSettings } from "@/lib/settings";
import type { BatchSpeechEngines } from "./engine";
import { localSpeech } from "./local";
import { workerRunner } from "./local-runner";
import { openaiSpeech } from "./openai";
import { openrouterSpeech } from "./openrouter";

export const batchEngines = (settings: Pick<WorkspaceSettings, "speech_local_model" | "speech_openrouter_model">): BatchSpeechEngines => ({
  openai: openaiSpeech,
  local: localSpeech(settings.speech_local_model, workerRunner),
  openrouter: openrouterSpeech(settings.speech_openrouter_model),
});
