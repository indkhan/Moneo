import { describe, expect, it, vi } from "vitest";
import { chooseSpeechEngine, transcribeWithFallback } from "./choose";
import type { BatchSpeechEngine, BatchSpeechEngines } from "./engine";

const audio = { samples: new Int16Array([1, 2, 3]), sampleRate: 24000 };
const hints = { prompt: "prompt", keywords: ["Netto"] };
const fake = (result: string | Error, available = true): BatchSpeechEngine & { transcribe: ReturnType<typeof vi.fn> } => ({
  available: async () => available,
  transcribe: vi.fn(async () => { if (result instanceof Error) throw result; return result; }),
});
const run = (chosen: "openai" | "local" | "openrouter", engines: BatchSpeechEngines) => transcribeWithFallback({ chosen, engines, audio, hints });

describe("choosing a speech engine", () => {
  it("uses the chosen engine when it is available", () => {
    expect(chooseSpeechEngine("local", { openai: true, local: true, openrouter: false })).toEqual({ engine: "local", fellBack: false });
  });
  it("falls back to OpenAI and says so when the chosen engine is unavailable", () => {
    expect(chooseSpeechEngine("local", { openai: true, local: false, openrouter: false })).toEqual({ engine: "openai", fellBack: true });
  });
  it("explains why the mic cannot work when there is no OpenAI key to fall back to", () => {
    const choice = chooseSpeechEngine("openrouter", { openai: false, local: true, openrouter: false });
    expect(choice).toMatchObject({ engine: null });
    expect(choice.engine === null && choice.reason).toContain("OpenRouter is not available");
    expect(choice.engine === null && choice.reason).toContain("OpenAI API key");
  });
  it("asks for an OpenAI key when OpenAI itself is chosen without one", () => {
    const choice = chooseSpeechEngine("openai", { openai: false, local: false, openrouter: false });
    expect(choice.engine === null && choice.reason).toContain("need an OpenAI API key");
  });
});

describe("transcribing with a fallback", () => {
  it("returns the chosen engine's words without touching OpenAI", async () => {
    const local = fake("spent twelve"), openai = fake("unused");
    expect(await run("local", { local, openai })).toEqual({ ok: true, text: "spent twelve", engine: "local", fellBack: false });
    expect(local.transcribe).toHaveBeenCalledWith(audio, hints, undefined);
    expect(openai.transcribe).not.toHaveBeenCalled();
  });
  it("uses OpenAI and reports it when the chosen engine is not installed", async () => {
    const openai = fake("from openai");
    expect(await run("local", { openai })).toEqual({ ok: true, text: "from openai", engine: "openai", fellBack: true });
  });
  it("uses OpenAI and reports it when the chosen engine fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const openai = fake("from openai");
    expect(await run("openrouter", { openrouter: fake(new Error("boom")), openai })).toEqual({ ok: true, text: "from openai", engine: "openai", fellBack: true });
  });
  it("fails with a reason when no OpenAI key exists to fall back to", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run("local", { local: fake(new Error("boom")), openai: fake("x", false) });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(await run("local", { openai: fake("x", false) })).toMatchObject({ ok: false, status: 503 });
  });
  it("does not retry OpenAI when OpenAI itself failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const openai = fake(new Error("quota"));
    expect(await run("openai", { openai })).toMatchObject({ ok: false, status: 502 });
    expect(openai.transcribe).toHaveBeenCalledOnce();
  });
  it("treats an engine whose availability check throws as unavailable", async () => {
    const broken: BatchSpeechEngine = { available: async () => { throw new Error("no"); }, transcribe: vi.fn() };
    expect(await run("local", { local: broken, openai: fake("from openai") })).toMatchObject({ ok: true, engine: "openai", fellBack: true });
    expect(broken.transcribe).not.toHaveBeenCalled();
  });
});
