import { AI_AGENTS, type AiAgent } from "@/lib/settings";
import type { UsageSource } from "@/lib/ai/usage-ledger";

const EXTRA_TASKS: Record<string, string> = {
  insights: "Insight wording", voice_summary: "Voice call summary", voice_realtime: "Voice call (live)",
  voice_transcription: "Live dictation", speech_to_text: "Speech to text", text_to_speech: "Voice sample",
};
const SOURCES: Record<UsageSource, string> = { chatgpt: "ChatGPT plan", claude: "Claude plan", openai: "OpenAI key", openrouter: "OpenRouter key", local: "On this computer", unknown: "Not recorded" };

export const taskLabel = (task: string) => task in AI_AGENTS ? AI_AGENTS[task as AiAgent].label : EXTRA_TASKS[task] ?? task;
export const sourceLabel = (source: string) => SOURCES[source as UsageSource] ?? source;
