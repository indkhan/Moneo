// Updates from Moneo's GitHub releases, started from Settings (through the bridge). Nothing is checked
// or downloaded until the owner asks. The owner's data lives outside the app folder, so an update
// keeps it; a pending database migration makes an automatic backup first (backend/index.ts).
import { app } from "electron";
import { autoUpdater } from "electron-updater";

export type UpdateStatus = {
  current: string;
  state: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";
  latest?: string;
  percent?: number;
  error?: string;
  /** Moneo installs it itself (Windows, Linux AppImage); otherwise install opens the download page. */
  installs: boolean;
};

const RELEASES = "https://github.com/indkhan/Moneo/releases";

// macOS only installs updates for signed apps, and a .deb comes from its package manager.
const canInstall = () => process.platform === "win32" || (process.platform === "linux" && Boolean(process.env.APPIMAGE));

export function createUpdater(options: {
  log(line: string): void;
  openExternal(url: string): Promise<void>;
  /** Start this program again once Moneo has quit (an AppImage's installer cannot wait for that). */
  relaunchAfterQuit(execPath: string): void;
  /** A generic update feed instead of GitHub (package tests with MONEO_DESKTOP_DEBUG=1 only). */
  feed?: string;
}) {
  let status: UpdateStatus = { current: app.getVersion(), state: "idle", installs: canInstall() };
  const set = (patch: Partial<UpdateStatus>) => { status = { ...status, ...patch }; return status; };
  const failed = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    options.log(`Update failed: ${message}`);
    // electron-updater's words when the repository has no published release (drafts do not count).
    if (/No published versions/i.test(message)) return set({ state: "current", latest: undefined, error: undefined });
    // Only installers carry app-update.yml; an unpacked build (npm run desktop:dist -- --dir) has none.
    if (/app-update\.yml/.test(message)) return set({ state: "error", error: "Updates work in the installed Moneo app." });
    return set({ state: "error", error: "Moneo could not reach its releases on GitHub, or the download failed. Check the internet connection and try again." });
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = { info: options.log, warn: options.log, error: options.log, debug: () => {} };
  // Normally the feed is the package's app-update.yml (electron-builder's publish setting): GitHub
  // releases, and the installer's publisher once Moneo is signed, so Windows checks the signature.
  if (options.feed) autoUpdater.setFeedURL({ provider: "generic", url: options.feed });
  autoUpdater.on("download-progress", progress => { if (status.state === "downloading") set({ percent: Math.floor(progress.percent) }); });
  // An installer that could not start is reported here, not thrown; Moneo keeps running.
  autoUpdater.on("error", error => { if (status.state === "installing") failed(error); });

  let checking: Promise<UpdateStatus> | undefined;
  function check() {
    if (status.state === "downloading" || status.state === "installing") return Promise.resolve(status);
    checking ??= (async () => {
      set({ state: "checking", error: undefined });
      try {
        const result = await autoUpdater.checkForUpdates();
        if (!result) return set({ state: "error", error: "Updates work in the installed Moneo app." });
        const latest = result.updateInfo.version;
        return set({ state: result.isUpdateAvailable ? "available" : "current", latest });
      } catch (error) { return failed(error); }
    })().finally(() => { checking = undefined; });
    return checking;
  }

  async function install() {
    if (status.state !== "available" || !status.latest) return status;
    if (!status.installs) {
      await options.openExternal(`${RELEASES}/tag/v${status.latest}`);
      return status;
    }
    set({ state: "downloading", percent: 0 });
    // The page follows progress through status(); Moneo then quits cleanly and the update starts it again.
    void autoUpdater.downloadUpdate().then(() => {
      set({ state: "installing" });
      options.log(`Installing Moneo ${status.latest}`);
      if (process.platform === "linux") {
        options.relaunchAfterQuit(process.env.APPIMAGE!);
        autoUpdater.quitAndInstall(true, false);
      } else autoUpdater.quitAndInstall(true, true);
    }, failed);
    return status;
  }

  return { status: () => status, check, install };
}
