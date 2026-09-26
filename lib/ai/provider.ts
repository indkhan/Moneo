import { createOpenRouter } from "@openrouter/ai-sdk-provider";

// OpenRouter via the Vercel AI SDK. Free models only (stack.md constraint).
// Docs: https://openrouter.ai/docs + https://ai-sdk.dev
export function getModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is missing. Add it to .env (see .env.example).");
  const openrouter = createOpenRouter({ apiKey });
  const modelId = process.env.OPENROUTER_MODEL ?? "qwen/qwen3.8-27b:free";
  return openrouter.chat(modelId);
}

export const SYSTEM_PROMPT =
  "You are Moneo, a personal-finance assistant. " +
  "Financial calculations come from application code, not guesses — state assumptions, cite the figures you use, " +
  "and never invent transactions. Be concise.";
