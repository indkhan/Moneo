import { afterEach, expect, it, vi } from "vitest";

const updater = vi.hoisted(() => ({
  setFeedURL: vi.fn(), on: vi.fn(), checkForUpdates: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getVersion: () => "0.1.4" } }));
vi.mock("electron-updater", () => ({ autoUpdater: updater }));
import { createUpdater } from "./updates";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("checks the previous release when the newest published release has no update files", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [
    { draft: false, prerelease: false, assets: [] },
    { draft: true, prerelease: false, assets: [{ name: "latest.yml", browser_download_url: "https://example.com/draft/latest.yml" }] },
    { draft: false, prerelease: false, assets: ["latest.yml", "latest-mac.yml", "latest-linux.yml"].map(name => ({ name, browser_download_url: `https://github.com/indkhan/Moneo/releases/download/v0.1.4/${name}` })) },
  ] }));
  updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: "0.1.4" }, isUpdateAvailable: false });
  const updates = createUpdater({ log: vi.fn(), openExternal: vi.fn(), relaunchAfterQuit: vi.fn() });
  expect(await updates.check()).toMatchObject({ state: "current", latest: "0.1.4" });
  expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: "generic", url: "https://github.com/indkhan/Moneo/releases/download/v0.1.4/" });
});
