import { afterEach, expect, it, vi } from "vitest";

const updater = vi.hoisted(() => ({
  setFeedURL: vi.fn(), on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getVersion: () => "0.1.4" } }));
vi.mock("electron-updater", () => ({ autoUpdater: updater }));
import { createUpdater } from "./updates";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

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

it("downloads the update first and installs it only when asked to restart", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [
    { draft: false, prerelease: false, body: "Faster imports", assets: ["latest.yml", "latest-mac.yml", "latest-linux.yml"].map(name => ({ name, browser_download_url: `https://github.com/indkhan/Moneo/releases/download/v0.2.0/${name}` })) },
  ] }));
  vi.stubGlobal("process", { ...process, platform: "win32" });
  updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: "0.2.0" }, isUpdateAvailable: true });
  updater.downloadUpdate.mockResolvedValue([]);
  const updates = createUpdater({ log: vi.fn(), openExternal: vi.fn(), relaunchAfterQuit: vi.fn() });
  expect(await updates.check()).toMatchObject({ state: "available", latest: "0.2.0", notes: "Faster imports" });
  await updates.install();
  await vi.runAllTimersAsync();
  expect(updates.status().state).toBe("downloaded");
  expect(await updates.check()).toMatchObject({ state: "downloaded" });
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(await updates.install()).toMatchObject({ state: "installing" });
  await vi.runAllTimersAsync();
  expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
});
