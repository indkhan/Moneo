import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ denied: false }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => { if (fixture.denied) throw new Error("Unauthorized"); return {}; } }));

const download = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
const post = (body: unknown) => POST(new Request("http://localhost/api/voice/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
let home: string, GET: typeof import("./route").GET, POST: typeof import("./route").POST;
beforeEach(async () => {
  vi.resetModules();
  ({ GET, POST } = await import("./route"));
  home = mkdtempSync(path.join(tmpdir(), "moneo-models-route-")); vi.stubEnv("MONEO_DATA_DIR", home); vi.stubGlobal("fetch", download); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { fixture.denied = false; rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); download.mockClear(); });

it("lists the suggested models as not downloaded in Moneo's data folder", async () => {
  const body = await (await GET(new Request("http://localhost/api/voice/models"))).json();
  expect(body.folder).toBe(path.join(home, "speech-models"));
  expect(body.models.map((model: { id: string }) => model.id)).toEqual(["moonshine-base", "whisper-base", "whisper-small", "distil-whisper"]);
  expect(body.models.every((model: { status: { state: string } }) => model.status.state === "missing")).toBe(true);
});

it("downloads a suggested model from its pinned revision", async () => {
  const response = await post({ model: "whisper-base" });
  expect(response.status).toBe(202);
  await vi.waitFor(() => expect(download).toHaveBeenCalled());
  expect(download.mock.calls[0][0]).toBe("https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/config.json");
});

it.each([["an unknown model", { model: "../../etc" }], ["no model", {}]])("downloads nothing for %s", async (_name, body) => {
  expect((await post(body)).status).toBe(400);
  expect(download).not.toHaveBeenCalled();
});

it("needs a signed-in owner", async () => {
  fixture.denied = true;
  expect((await GET(new Request("http://localhost/api/voice/models"))).status).toBe(401);
  expect((await post({ model: "whisper-base" })).status).toBe(401);
  expect(download).not.toHaveBeenCalled();
});
