import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { WorkspaceSettings } from "@/lib/settings";

// OpenRouter via the Vercel AI SDK.
// Docs: https://openrouter.ai/docs + https://ai-sdk.dev
export function getModel(modelOverride?: string) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is missing. Add it to .env (see .env.example).");
  const openrouter = createOpenRouter({ apiKey });
  const modelId = modelOverride ?? process.env.OPENROUTER_MODEL ?? "qwen/qwen3.8-27b:free";
  return openrouter.chat(modelId, { provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0, audio: 0 } } });
}

export async function listFreeModels() {
  const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10000), cache: "no-store" });
  if (!response.ok) throw new Error("Free model availability could not be verified; try again later");
  const body = await response.json() as { data?: { id: string; name: string; pricing?: Record<string, string>; supported_parameters?: string[] }[] };
  if (!Array.isArray(body.data)) throw new Error("Provider model catalogue is invalid");
  return body.data.filter(model => model.pricing && Object.values(model.pricing).length > 0 &&
    Object.values(model.pricing).every(price => typeof price === "string" && /^0(?:\.0+)?$/.test(price)) &&
    model.supported_parameters?.includes("tools") && model.supported_parameters?.includes("response_format"))
    .map(model => ({ id: model.id, name: model.name }));
}

export async function modelForSettings(settings?: WorkspaceSettings) {
  const id = settings?.openrouter_model ?? process.env.OPENROUTER_MODEL ?? "qwen/qwen3.8-27b:free";
  if (!(await listFreeModels()).some(model => model.id === id))
    throw new Error("Selected model is unavailable, lacks required capabilities, or is no longer free; choose a verified free model in Settings");
  return getModel(id);
}

export const SYSTEM_PROMPT =
  "You are Moneo, a personal-finance assistant. " +
  "Financial calculations come from application code, not guesses — state assumptions, cite the figures you use, " +
  "and never invent transactions. Be concise.";
