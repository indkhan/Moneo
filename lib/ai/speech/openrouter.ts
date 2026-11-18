import { z } from "zod";
import { serviceKey } from "@/lib/service-keys";
import { encodeWav } from "./audio";
import { promptWithNames } from "./hints";
import type { BatchSpeechEngine } from "./engine";

const API = "https://openrouter.ai/api/v1";
const INSTRUCTION = "Transcribe the audio. Reply with the plain transcript only: no quotes, labels or commentary. Keep the language that was spoken.";

const modelsSchema = z.object({ data: z.array(z.object({
  id: z.string().min(1), name: z.string().optional(),
  architecture: z.object({ input_modalities: z.array(z.string()).optional() }).optional(),
})) });
const completionSchema = z.object({ choices: z.array(z.object({ message: z.object({
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]).nullable(),
}) })).min(1) });

export type OpenRouterAudioModel = { id: string; name: string };
export type OpenRouterModels = { configured: false } | { configured: true; models: OpenRouterAudioModel[]; error?: string };

export async function listAudioModels(apiKey: string, fetcher: typeof fetch = fetch): Promise<OpenRouterAudioModel[]> {
  const response = await fetcher(`${API}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`OpenRouter models failed (${response.status})`);
  return modelsSchema.parse(await response.json()).data
    .filter(model => model.architecture?.input_modalities?.includes("audio"))
    .map(model => ({ id: model.id, name: model.name || model.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function openrouterModels(fetcher: typeof fetch = fetch): Promise<OpenRouterModels> {
  const apiKey = await serviceKey("openrouter_api_key");
  if (!apiKey) return { configured: false };
  try { return { configured: true, models: await listAudioModels(apiKey, fetcher) }; }
  catch { return { configured: true, models: [], error: "OpenRouter's model list could not be loaded. Check your connection and try again." }; }
}

export const openrouterSpeech = (model: string | null, fetcher: typeof fetch = fetch): BatchSpeechEngine => ({
  available: async () => Boolean(model) && Boolean(await serviceKey("openrouter_api_key")),
  async transcribe(audio, hints, signal) {
    const apiKey = await serviceKey("openrouter_api_key");
    if (!apiKey || !model) throw new Error("OpenRouter speech is not set up");
    const wav = Buffer.from(encodeWav(audio)).toString("base64");
    const response = await fetcher(`${API}/chat/completions`, {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, temperature: 0, stream: false,
        messages: [{ role: "user", content: [
          { type: "text", text: `${INSTRUCTION} ${promptWithNames(hints)}` },
          { type: "input_audio", input_audio: { data: wav, format: "wav" } },
        ] }],
      }),
    });
    if (!response.ok) throw new Error(`OpenRouter transcription failed (${response.status})`);
    const { content } = completionSchema.parse(await response.json()).choices[0].message;
    return typeof content === "string" ? content : (content ?? []).map(part => part.text ?? "").join("");
  },
});
