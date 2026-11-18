import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

const fixture = vi.hoisted(() => ({ denied: false, engine: "local", model: "", idle: true, transcribe: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => {
  if (fixture.denied) throw new Error("Unauthorized");
  const query = { select: () => query, eq: () => query, is: () => query, not: () => query, order: () => query, limit: () => Promise.resolve({ data: [], error: null }) };
  return { supabase: { from: () => query }, workspace: { id: "workspace-1" },
    settings: { ai_data_scopes: [], speech_engine: fixture.engine, speech_local_model: fixture.model, speech_openrouter_model: "openai/whisper" } };
} }));
vi.mock("@/lib/ai/speech/local-runner", () => ({ workerRunner: { idle: () => fixture.idle, transcribe: fixture.transcribe } }));

const paid = vi.fn();
const pcm = new Uint8Array(new Int16Array([1, 2, 3, 4, 5, 6]).buffer);
const interim = () => POST(new Request("http://localhost/api/voice/interim?rate=24000", { method: "POST", headers: { "Content-Type": "audio/pcm" }, body: pcm as BodyInit }));
let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "moneo-interim-"));
  fixture.model = path.join(home, "whisper");
  mkdirSync(path.join(fixture.model, "onnx"), { recursive: true });
  writeFileSync(path.join(fixture.model, "config.json"), '{"model_type":"whisper"}');
  for (const file of ["tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "generation_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged.onnx"]) writeFileSync(path.join(fixture.model, file), "{}");
  vi.stubEnv("MONEO_DATA_DIR", home);
  vi.stubEnv("OPENAI_API_KEY", "sk-server-only");
  vi.stubGlobal("fetch", paid);
});
afterEach(() => {
  Object.assign(fixture, { denied: false, engine: "local", idle: true });
  fixture.transcribe.mockReset(); paid.mockReset();
  rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

it("requires a signed-in workspace", async () => {
  fixture.denied = true;
  expect((await interim()).status).toBe(401);
  expect(fixture.transcribe).not.toHaveBeenCalled();
});

it("returns the words the model on this computer heard so far", async () => {
  fixture.transcribe.mockResolvedValue(" spent twelve ");
  const response = await interim();
  expect(await response.json()).toEqual({ text: "spent twelve" });
  expect(fixture.transcribe).toHaveBeenCalledWith(expect.objectContaining({ folder: fixture.model }));
});

it("says busy instead of queuing behind a transcription that is still running", async () => {
  fixture.idle = false;
  expect(await (await interim()).json()).toEqual({ busy: true });
  expect(fixture.transcribe).not.toHaveBeenCalled();
});

it.each(["openai", "openrouter"])("never sends live words to the paid %s engine", async engine => {
  fixture.engine = engine;
  expect((await interim()).status).toBe(409);
  expect(paid).not.toHaveBeenCalled();
});

it("reports a model failure without falling back to OpenAI", async () => {
  fixture.transcribe.mockRejectedValue(new Error("onnx failed"));
  expect((await interim()).status).toBe(502);
  expect(paid).not.toHaveBeenCalled();
});
