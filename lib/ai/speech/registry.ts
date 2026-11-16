import type { WorkspaceSettings } from "@/lib/settings";
import type { BatchSpeechEngines } from "./engine";
import { localSpeech } from "./local";
import { workerRunner } from "./local-runner";
import { openaiSpeech } from "./openai";

export const batchEngines = (settings: Pick<WorkspaceSettings, "speech_local_model">): BatchSpeechEngines => ({
  openai: openaiSpeech,
  local: localSpeech(settings.speech_local_model, workerRunner),
});
