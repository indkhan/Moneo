import type { BatchSpeechEngines } from "./engine";
import { openaiSpeech } from "./openai";

export const batchEngines: BatchSpeechEngines = { openai: openaiSpeech };
