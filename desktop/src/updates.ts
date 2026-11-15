import { app } from "electron";
import { autoUpdater } from "electron-updater";

export type UpdateStatus = {
  current: string;
  state: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";
  latest?: string;
  percent?: number;
  error?: string;
  installs: boolean;
};

const RELEASES = "https://github.com/indkhan/Moneo/releases";

const canInstall = () => process.platform === "win32" || (process.platform === "linux" && Boolean(process.env.APPIMAGE));

export function createUpdater(options: {
  log(line: string): void;
  openExternal(url: string): Promise<void>;
  relaunchAfterQuit(execPath: string): void;
  feed?: string;
}) {
  let status: UpdateStatus = { current: app.getVersion(), state: "idle", installs: canInstall() };
  const set = (patch: Partial<UpdateStatus>) => { status = { ...status, ...patch }; return status; };
  const failed = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    options.log(`Update failed: ${message}`);
    if (/No published versions/i.test(message)) return set({ state: "current", latest: undefined, error: undefined });
    if (/app-update\.yml/.test(message)) return set({ state: "error", error: "Updates work in the installed Moneo app." });
    return set({ state: "error", error: "Moneo could not reach its releases on GitHub, or the download failed. Check the internet connection and try again." });
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = { info: options.log, warn: options.log, error: options.log, debug: () => {} };
  if (options.feed) autoUpdater.setFeedURL({ provider: "generic", url: options.feed });
  autoUpdater.on("download-progress", progress => { if (status.state === "downloading") set({ percent: Math.floor(progress.percent) }); });
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
