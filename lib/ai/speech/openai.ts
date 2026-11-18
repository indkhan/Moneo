import { z } from "zod";
import { voiceApiKey } from "@/lib/ai/configured";
import { encodeWav } from "./audio";
import { promptWithNames } from "./hints";
import type { BatchSpeechEngine } from "./engine";

const MODEL = "gpt-4o-transcribe";
const responseSchema = z.object({ text: z.string() });

export const openaiSpeech: BatchSpeechEngine = {
  available: async () => Boolean(await voiceApiKey()),
  async transcribe(audio, hints, signal) {
    const apiKey = await voiceApiKey();
    if (!apiKey) throw new Error("No OpenAI API key");
    const form = new FormData();
    form.set("model", MODEL);
    form.set("response_format", "json");
    form.set("prompt", promptWithNames(hints));
    form.set("file", new Blob([encodeWav(audio)], { type: "audio/wav" }), "voice.wav");
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal });
    if (!response.ok) throw new Error(`OpenAI transcription failed (${response.status})`);
    return responseSchema.parse(await response.json()).text;
  },
};
