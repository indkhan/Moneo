import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({}) }));

const bridge = vi.fn(async () => Response.json({ path: "/Users/owner/Models/whisper-small" }));
const choose = (host = "localhost:47300") => POST(new Request("http://localhost/api/voice/models/folder", { method: "POST", headers: { host } }));
beforeEach(() => { vi.stubEnv("MONEO_DESKTOP", "1"); vi.stubEnv("MONEO_DESKTOP_BRIDGE", "http://127.0.0.1:5000/token"); vi.stubGlobal("fetch", bridge); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); bridge.mockClear(); });

it("opens the desktop app's folder picker and returns the folder", async () => {
  expect(await (await choose()).json()).toEqual({ folder: "/Users/owner/Models/whisper-small" });
  expect(bridge).toHaveBeenCalledWith("http://127.0.0.1:5000/token/choose-folder", expect.objectContaining({ method: "POST" }));
});

it("never opens a picker on the computer when asked from a phone", async () => {
  expect((await choose("laptop.tail1234.ts.net")).status).toBe(403);
  expect(bridge).not.toHaveBeenCalled();
});

it("has no picker outside the desktop app", async () => {
  vi.stubEnv("MONEO_DESKTOP", "");
  expect((await choose()).status).toBe(404);
  expect(bridge).not.toHaveBeenCalled();
});
