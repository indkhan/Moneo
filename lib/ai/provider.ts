import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { AI_AGENTS, type AiAgent, type WorkspaceSettings } from "@/lib/settings";

// Each agent uses the model typed in Settings, else its default. OpenRouter IDs are
// "vendor/model" and go to OpenRouter; plain IDs ("gpt-6.1-sol") go to OpenAI.
// Docs: https://ai-sdk.dev/providers/ai-sdk-providers/openai + https://openrouter.ai/docs
export function getModel(modelId: string) {
  if (modelId.includes("/")) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is missing. Add it to .env (see .env.example).");
    return createOpenRouter({ apiKey }).chat(modelId);
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing. Add it to .env (see .env.example).");
  return createOpenAI({ apiKey })(modelId);
}

export function modelIdFor(settings: WorkspaceSettings | undefined, agent: AiAgent) {
  return settings?.ai_models[agent] ?? AI_AGENTS[agent].model;
}

export async function modelForSettings(settings: WorkspaceSettings | undefined, agent: AiAgent) {
  return getModel(modelIdFor(settings, agent));
}

export const SYSTEM_PROMPT =
  "You are Moneo, a personal-finance assistant. " +
  "Financial calculations come from application code, not guesses — state assumptions, cite the figures you use, " +
  "and never invent transactions. Excluded classifications are unknown: partial totals are not upper or lower bounds. " +
  "Use includedTransactionCount for counted rows; transactionCount includes excluded rows. " +
  "Use only links returned by tools, never invent app:// links. Do not infer data coverage from filenames. " +
  "Balance freshness does not establish whether import processing completed; check imports_status. Completed imports do not prove complete financial coverage. " +
  "Write concise plain paragraphs; the chat does not render Markdown formatting.";
