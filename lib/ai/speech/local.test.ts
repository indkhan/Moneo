import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { transcribeWithFallback } from "./choose";
import type { BatchSpeechEngine } from "./engine";
import { localSpeech, type SpeechModelRunner } from "./local";
import { localModel } from "./local-models";

const audio = { samples: new Int16Array([0, 16384, -16384, 32767, 0, 0]), sampleRate: 24000 };
const hints = { prompt: "A voice note.", keywords: ["Netto", "Girokonto"] };
const openai: BatchSpeechEngine = { available: async () => true, transcribe: vi.fn(async () => "from openai") };
let home: string;

function modelFolder(name: string, type = "whisper", weights = ["encoder_model_quantized.onnx", "decoder_model_merged_quantized.onnx"]) {
  const folder = path.join(home, name);
  mkdirSync(path.join(folder, "onnx"), { recursive: true });
  writeFileSync(path.join(folder, "config.json"), JSON.stringify({ model_type: type }));
  for (const file of ["tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "generation_config.json"]) writeFileSync(path.join(folder, file), "{}");
  for (const file of weights) writeFileSync(path.join(folder, "onnx", file), "weights");
  return folder;
}
const runner = (result: string | Error, idle = true) => ({ idle: () => idle, transcribe: vi.fn<SpeechModelRunner["transcribe"]>(async () => { if (result instanceof Error) throw result; return result; }) }) satisfies SpeechModelRunner;
const run = (ref: string | null, model: SpeechModelRunner) => transcribeWithFallback({ chosen: "local", engines: { local: localSpeech(ref, model), openai }, audio, hints, onAttempt: () => undefined });

beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "moneo-speech-")); vi.stubEnv("MONEO_DATA_DIR", home); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.mocked(openai.transcribe).mockClear(); });

it("runs the owner's own model folder on this computer with the vocabulary as its prompt", async () => {
  const folder = modelFolder("my-whisper");
  const model = runner("spent twelve at Netto");
  expect(await run(folder, model)).toEqual({ ok: true, text: "spent twelve at Netto", engine: "local", fellBack: false });
  const job = model.transcribe.mock.calls[0][0];
  expect(job).toMatchObject({ folder, family: "whisper", dtype: "q8" });
  expect(job.prompt).toContain("Netto, Girokonto");
  expect(job.samples.length).toBe(4);
  expect(job.samples[0]).toBe(0);
  expect(job.samples.every((sample: number) => sample >= -1 && sample <= 1)).toBe(true);
  expect(openai.transcribe).not.toHaveBeenCalled();
});

it("uses a suggested model only once every file is in Moneo's data folder", async () => {
  const moonshine = localModel("moonshine-base")!;
  const folder = path.join(home, "speech-models", "moonshine-base");
  const model = runner("hello");
  expect(await run("moonshine-base", model)).toMatchObject({ engine: "openai", fellBack: true });
  for (const file of moonshine.files) {
    mkdirSync(path.dirname(path.join(folder, file.path)), { recursive: true });
    const json = file.path === "config.json" ? '{"model_type":"moonshine"}' : "{}";
    writeFileSync(path.join(folder, file.path), json.padEnd(Math.min(file.bytes, 4096), " "));
    truncateSync(path.join(folder, file.path), file.bytes);
  }
  expect(await run("moonshine-base", model)).toEqual({ ok: true, text: "hello", engine: "local", fellBack: false });
  expect(model.transcribe.mock.calls[0][0]).toMatchObject({ folder, family: "moonshine", dtype: "q8" });
});

it.each([
  ["no model chosen", () => null],
  ["a folder that is not there", () => path.join(home, "gone")],
  ["a folder without the model weights", () => modelFolder("half", "whisper", [])],
  ["a model type it cannot run", () => modelFolder("llama", "llama")],
  ["a relative path", () => "models/whisper"],
])("falls back to OpenAI with %s", async (_name, ref) => {
  const model = runner("unused");
  expect(await run(ref(), model)).toMatchObject({ ok: true, text: "from openai", engine: "openai", fellBack: true });
  expect(model.transcribe).not.toHaveBeenCalled();
});

it("falls back to OpenAI when the model fails while transcribing", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await run(modelFolder("broken"), runner(new Error("onnx failed")))).toMatchObject({ ok: true, text: "from openai", engine: "openai", fellBack: true });
});

it("hears live words only while the model is free, so a slow computer never queues them up", async () => {
  const folder = modelFolder("live-whisper");
  const free = runner("spent twelve");
  expect(await localSpeech(folder, free).interim!(audio, hints)).toBe("spent twelve");
  expect(free.transcribe.mock.calls[0][0].prompt).toContain("Netto, Girokonto");
  const busy = runner("unused", false);
  expect(await localSpeech(folder, busy).interim!(audio, hints)).toBeNull();
  expect(busy.transcribe).not.toHaveBeenCalled();
});
