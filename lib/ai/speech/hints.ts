import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiDataScope } from "@/lib/settings";
import { loadVoiceVocabulary } from "@/lib/ai/voice-vocabulary";
import type { SpeechHints } from "./engine";

const speechWorksWithoutNameHints = (): string[] => [];

export const SPEECH_PROMPT = "A short personal-finance voice note: spending, income, transfers, amounts with currencies, and names of accounts, shops and categories.";

export async function loadSpeechHints(supabase: SupabaseClient, workspaceId: string, scopes: readonly AiDataScope[]): Promise<SpeechHints> {
  return { prompt: SPEECH_PROMPT, keywords: await loadVoiceVocabulary(supabase, workspaceId, scopes).catch(speechWorksWithoutNameHints) };
}

const MAX_HINT_CHARACTERS = 800;
export function promptWithNames(hints: SpeechHints) {
  const names = hints.keywords.join(", ").slice(0, MAX_HINT_CHARACTERS);
  return names ? `${hints.prompt} Names that may come up: ${names}.` : hints.prompt;
}
