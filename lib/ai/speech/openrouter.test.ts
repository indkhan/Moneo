import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeWav } from "./audio";
import { speechAvailability, transcribeWithFallback } from "./choose";
import type { BatchSpeechEngine } from "./engine";
import { listAudioModels, openrouterModels, openrouterSpeech } from "./openrouter";
import { batchEngines } from "./registry";

const audio = { samples: new Int16Array([1, 2, 3, 4]), sampleRate: 24000 };
const hints = { prompt: "A voice note.", keywords: ["Netto", "Girokonto"] };
const completion = (content: unknown) => Response.json({ choices: [{ message: { content } }] });
const fetcher = vi.fn<typeof fetch>();
const openai: BatchSpeechEngine = { available: async () => true, transcribe: vi.fn(async () => "from openai") };

beforeEach(() => { vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test"); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); fetcher.mockReset(); vi.mocked(openai.transcribe).mockClear(); });

it("sends the recording as WAV audio with a transcript-only instruction and the vocabulary", async () => {
  fetcher.mockResolvedValue(completion(" Spent twelve at Netto "));
  const text = await openrouterSpeech("google/gemini-audio", fetcher).transcribe(audio, hints);
  expect(text).toBe(" Spent twelve at Netto ");
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
  const body = JSON.parse(init!.body as string);
  expect(body.model).toBe("google/gemini-audio");
  const [instruction, clip] = body.messages[0].content;
  expect(instruction.text).toMatch(/plain transcript only/);
  expect(instruction.text).toContain("Netto, Girokonto");
  expect(clip).toEqual({ type: "input_audio", input_audio: { data: Buffer.from(encodeWav(audio)).toString("base64"), format: "wav" } });
});

it("reads a reply split into text parts", async () => {
  fetcher.mockResolvedValue(completion([{ type: "text", text: "Spent " }, { type: "text", text: "twelve" }]));
  expect(await openrouterSpeech("m/a", fetcher).transcribe(audio, hints)).toBe("Spent twelve");
});

it("rejects a failed or empty reply so the fallback can run", async () => {
  fetcher.mockResolvedValueOnce(new Response("{}", { status: 402 }));
  await expect(openrouterSpeech("m/a", fetcher).transcribe(audio, hints)).rejects.toThrow("402");
  fetcher.mockResolvedValueOnce(Response.json({ choices: [] }));
  await expect(openrouterSpeech("m/a", fetcher).transcribe(audio, hints)).rejects.toThrow();
});

it("is only selectable with both an OpenRouter key and a chosen model", async () => {
  const available = (model: string | null) => openrouterSpeech(model, fetcher).available();
  expect(await available("m/a")).toBe(true);
  expect(await available(null)).toBe(false);
  vi.stubEnv("OPENROUTER_API_KEY", "");
  expect(await available("m/a")).toBe(false);
});

it("is the engine the registry returns for the stored OpenRouter model", async () => {
  const engines = batchEngines({ speech_local_model: null, speech_openrouter_model: "m/a" });
  expect((await speechAvailability(engines)).openrouter).toBe(true);
  expect((await speechAvailability(batchEngines({ speech_local_model: null, speech_openrouter_model: null }))).openrouter).toBe(false);
});

it("uses OpenAI and says so when OpenRouter fails", async () => {
  fetcher.mockResolvedValue(new Response("{}", { status: 500 }));
  const result = await transcribeWithFallback({ chosen: "openrouter", engines: { openai, openrouter: openrouterSpeech("m/a", fetcher) }, audio, hints });
  expect(result).toEqual({ ok: true, text: "from openai", engine: "openai", fellBack: true });
});

it("uses OpenAI and says so when no model is chosen, without calling OpenRouter", async () => {
  const result = await transcribeWithFallback({ chosen: "openrouter", engines: { openai, openrouter: openrouterSpeech(null, fetcher) }, audio, hints });
  expect(result).toMatchObject({ engine: "openai", fellBack: true });
  expect(fetcher).not.toHaveBeenCalled();
});

it("lists only models that accept audio input, sorted by name", async () => {
  fetcher.mockResolvedValue(Response.json({ data: [
    { id: "b/voice", name: "B Voice", architecture: { input_modalities: ["text", "audio"] } },
    { id: "a/text", name: "A Text", architecture: { input_modalities: ["text", "image"] } },
    { id: "c/none", name: "C None" },
    { id: "a/listen", architecture: { input_modalities: ["audio"] } },
  ] }));
  expect(await listAudioModels("sk-or-test", fetcher)).toEqual([{ id: "a/listen", name: "a/listen" }, { id: "b/voice", name: "B Voice" }]);
  expect((fetcher.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
});

it("explains why the option cannot be used with no key or an unreachable list", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  expect(await openrouterModels(fetcher)).toEqual({ configured: false });
  expect(fetcher).not.toHaveBeenCalled();
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  fetcher.mockResolvedValue(new Response("{}", { status: 503 }));
  expect(await openrouterModels(fetcher)).toMatchObject({ configured: true, models: [], error: expect.any(String) });
});
