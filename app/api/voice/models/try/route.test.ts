import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

const fixture = vi.hoisted(() => ({ denied: false, transcribe: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => {
  if (fixture.denied) throw new Error("Unauthorized");
  const query = { select: () => query, eq: () => query, is: () => query, not: () => query, order: () => query, limit: () => Promise.resolve({ data: [], error: null }) };
  return { supabase: { from: () => query }, workspace: { id: "workspace-1" }, settings: { ai_data_scopes: [], speech_engine: "openai" } };
} }));
vi.mock("@/lib/ai/speech/local-runner", () => ({ workerRunner: { transcribe: fixture.transcribe } }));

const openai = vi.fn();
const pcm = new Uint8Array(new Int16Array([1, 2, 3, 4, 5, 6]).buffer);
let home: string, folder: string;
const attempt = (model: string | null) => POST(new Request(`http://localhost/api/voice/models/try?rate=24000${model ? `&model=${encodeURIComponent(model)}` : ""}`, { method: "POST", headers: { "Content-Type": "audio/pcm" }, body: pcm as BodyInit }));

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "moneo-try-"));
  folder = path.join(home, "whisper");
  mkdirSync(path.join(folder, "onnx"), { recursive: true });
  writeFileSync(path.join(folder, "config.json"), '{"model_type":"whisper"}');
  for (const file of ["tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "generation_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged.onnx"]) writeFileSync(path.join(folder, file), "{}");
  vi.stubEnv("MONEO_DATA_DIR", home);
  vi.stubEnv("OPENAI_API_KEY", "sk-server-only");
  vi.stubGlobal("fetch", openai);
});
afterEach(() => { fixture.denied = false; fixture.transcribe.mockReset(); rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("transcribes with the model being tried, even before it is saved as the choice", async () => {
  fixture.transcribe.mockResolvedValue(" twelve euros at Netto ");
  const response = await attempt(folder);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ text: "twelve euros at Netto" });
  expect(fixture.transcribe).toHaveBeenCalledWith(expect.objectContaining({ folder, family: "whisper", dtype: "fp32" }));
});

it("reports a model failure instead of quietly using OpenAI", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fixture.transcribe.mockRejectedValue(new Error("onnx failed"));
  const response = await attempt(folder);
  expect(response.status).toBe(502);
  expect(openai).not.toHaveBeenCalled();
});

it("asks for a model first when the one being tried is not there", async () => {
  expect((await attempt("whisper-small")).status).toBe(409);
  expect((await attempt(null)).status).toBe(409);
  expect(fixture.transcribe).not.toHaveBeenCalled();
});

it("needs a signed-in owner before running a model", async () => {
  fixture.denied = true;
  expect((await attempt(folder)).status).toBe(401);
  expect(fixture.transcribe).not.toHaveBeenCalled();
});
