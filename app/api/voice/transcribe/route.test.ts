import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";
import { encodeWav, MAX_SPEECH_BYTES } from "@/lib/ai/speech/audio";

const fixture = vi.hoisted(() => ({ denied: false, engine: "openai" as string }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => {
  if (fixture.denied) throw new Error("Unauthorized");
  const query = { select: () => query, eq: () => query, is: () => query, not: () => query, order: () => query, limit: () => Promise.resolve({ data: [], error: null }) };
  return { supabase: { from: () => query }, workspace: { id: "workspace-1" }, settings: { ai_data_scopes: [], speech_engine: fixture.engine } };
} }));

const openai = vi.fn();
const pcm = new Uint8Array(new Int16Array([1, 2, 3, 4]).buffer);
const request = (body: BodyInit | null = pcm as BodyInit, init: { type?: string; rate?: string | null; headers?: Record<string, string> } = {}) => {
  const { type = "audio/pcm", rate = "24000", headers = {} } = init;
  return new Request(`http://localhost/api/voice/transcribe${rate ? `?rate=${rate}` : ""}`, { method: "POST", headers: { "Content-Type": type, ...headers }, body });
};
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-server-only");
  vi.stubGlobal("fetch", openai);
  openai.mockResolvedValue(Response.json({ text: " Spent twelve at Netto " }));
});
afterEach(() => { fixture.denied = false; fixture.engine = "openai"; vi.unstubAllEnvs(); vi.unstubAllGlobals(); openai.mockReset(); });

it("requires a signed-in workspace before reading the audio", async () => {
  fixture.denied = true;
  expect((await POST(request())).status).toBe(401);
  expect(openai).not.toHaveBeenCalled();
});

it.each([
  ["empty audio", () => request(new Uint8Array())],
  ["raw PCM without a rate", () => request(pcm as BodyInit, { rate: null })],
  ["an unsupported media type", () => request(pcm as BodyInit, { type: "audio/mpeg" })],
  ["a WAV with no header", () => request(pcm as BodyInit, { type: "audio/wav", rate: null })],
])("rejects %s without calling OpenAI", async (_name, make) => {
  expect((await POST(make())).status).toBe(400);
  expect(openai).not.toHaveBeenCalled();
});

it("rejects audio over the size limit before transcribing it", async () => {
  expect((await POST(request(new Uint8Array(MAX_SPEECH_BYTES + 2)))).status).toBe(413);
  expect((await POST(request(pcm as BodyInit, { headers: { "Content-Length": String(MAX_SPEECH_BYTES + 1) } }))).status).toBe(413);
  expect(openai).not.toHaveBeenCalled();
});

it("sends the recording to OpenAI as a WAV file and returns the words", async () => {
  const response = await POST(request());
  expect(await response.json()).toEqual({ text: "Spent twelve at Netto", engine: "openai", fellBack: false });
  const [url, init] = openai.mock.calls[0];
  expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(init.headers.Authorization).toBe("Bearer sk-server-only");
  const file = init.body.get("file") as File;
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(encodeWav({ samples: new Int16Array([1, 2, 3, 4]), sampleRate: 24000 }));
});

it("accepts a WAV upload", async () => {
  const wav = encodeWav({ samples: new Int16Array([5, 6]), sampleRate: 16000 });
  expect((await POST(request(wav as BodyInit, { type: "audio/wav", rate: null }))).status).toBe(200);
});

it("uses OpenAI and says so when the chosen engine is not available", async () => {
  fixture.engine = "local";
  expect(await (await POST(request())).json()).toEqual({ text: "Spent twelve at Netto", engine: "openai", fellBack: true });
});

it("explains that the mic cannot work with no engine and no OpenAI key", async () => {
  fixture.engine = "local";
  vi.stubEnv("OPENAI_API_KEY", "");
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect((await response.json()).error).toContain("OpenAI API key");
  expect(openai).not.toHaveBeenCalled();
});

it("reports an OpenAI failure without its details", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  openai.mockResolvedValue(Response.json({ error: { message: "quota for sk-server-only" } }, { status: 429 }));
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Voice input is unavailable. Try again." });
});
