import { app, BrowserWindow, dialog, Notification, powerMonitor, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { backup, restore, startBackend, type BackendPaths, type RunningBackend } from "./backend";
import { createAppWindow, lockDownSession, openExternal, setAppPort, showReturn } from "./app-window";
import { startBridge } from "./bridge";
import { ensureBankCertificate } from "./certificate";
import { NextServer } from "./next-server";
import { backupsDir, home, log, readSettings, resources, setupHome, updateSettings } from "./paths";
import { choosePort } from "./port";
import { closeSetup, focusSetup, progress, registerSetupIpc, setSetupState, showSetup } from "./setup-window";
import { createTray, openedAtLogin, type TrayActions } from "./tray";
import { createUpdater } from "./updates";

// MONEO_DESKTOP_DEBUG=1 allows debugging switches and the test hooks below (package smoke tests).
const debug = process.env.MONEO_DESKTOP_DEBUG === "1";
// A debugging port or inspector would let any program on this computer drive the owner's signed-in window.
const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "inspect-port", "inspect-brk-node", "inspect-publish-uid"];

setupHome();
const refused = app.isPackaged && !debug ? DEBUG_SWITCHES.filter(name => app.commandLine.hasSwitch(name)) : [];
if (refused.length) {
  log(`Refusing to start with --${refused.join(", --")} (debugging switches need MONEO_DESKTOP_DEBUG=1)`);
  app.exit(1);
} else if (!app.requestSingleInstanceLock() || process.argv.includes("--quit")) {
  // A second launch hands its arguments to the running Moneo; `--quit` with none running does nothing.
  app.quit();
} else main();

function main() {
  const paths: BackendPaths = { resources: resources(), home: home() };
  const hidden = openedAtLogin();
  let backend: RunningBackend | undefined;
  let server: NextServer | undefined;
  let window: BrowserWindow | undefined;
  let booting: Promise<void> | undefined;
  let busy = false; // stopping for a restore or a retry: service exits are expected
  let quitting = false;
  let failed = false;
  let port = 0;
  let backupTimer: NodeJS.Timeout | undefined;
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  let relaunchPath: string | undefined;
  const updater = createUpdater({
    log: line => log(`Update: ${line}`),
    openExternal,
    relaunchAfterQuit: execPath => { relaunchPath = execPath; },
    feed: debug ? process.env.MONEO_DESKTOP_UPDATE_FEED : undefined,
  });

  const message = (error: unknown) => error instanceof Error ? error.message : String(error);

  function fail(summary: string, error: unknown) {
    failed = true;
    log(`${summary}: ${message(error)}`);
    const [first, ...rest] = message(error).split("\n");
    setSetupState({ phase: "failed", error: { summary: `${summary}: ${first}`, detail: rest.join("\n") } });
    focusSetup();
  }

  async function stopServices() {
    clearInterval(backupTimer);
    await server?.stop().catch(error => log(`Stopping the server failed: ${message(error)}`));
    server = undefined;
    await backend?.stop().catch(error => log(`Stopping the backend failed: ${message(error)}`));
    backend = undefined;
  }

  function boot(reason: string) {
    booting ??= (async () => {
      log(`Starting services (${reason})`);
      failed = false;
      setSetupState({ phase: "starting", steps: [], error: undefined, firstRun: !existsSync(path.join(paths.home, "config.json")), version: app.getVersion() });
      if (!hidden || window) showSetup(!window?.isVisible());
      try {
        port = await choosePort();
        setAppPort(port);
        progress({ id: "certificate", label: "Preparing bank connections", state: "running" });
        const certificate = await ensureBankCertificate();
        progress({ id: "certificate", label: "Preparing bank connections", state: "done", detail: certificate ? undefined : "Unavailable; see the logs" });
        const running = await startBackend(paths, progress, { appUrl: `http://localhost:${port}`, appVersion: app.getVersion() });
        backend = running;
        running.onExit((service, code) => {
          if (quitting || busy || backend !== running) return;
          fail(`A Moneo service stopped (${service})`, new Error(`It exited with code ${code}. Try again, or open the logs folder.`));
        });
        progress({ id: "app", label: "Starting Moneo", state: "running" });
        // What the server asks of the app: sign-in results in the window, and updates (see bridge.ts).
        bridge ??= await startBridge({
          onReturn: async returnPath => {
            if (!window || booting || failed) throw new Error("The app window is not open");
            await showReturn(window, returnPath);
          },
          update: updater,
        });
        server = new NextServer({ appDir: path.join(paths.resources, "app"), port, env: { ...running.env, MONEO_DESKTOP_BRIDGE: bridge.url, MONEO_DESKTOP_VERSION: app.getVersion() } }, error => fail("The Moneo server keeps stopping", error));
        await server.start();
        progress({ id: "app", label: "Starting Moneo", state: "done" });
        if (quitting) return;
        await showApp(!hidden || Boolean(window?.isVisible()));
        closeSetup();
        scheduleBackups();
      } catch (error) {
        progress({ id: "app", label: "Starting Moneo", state: "error" });
        await stopServices();
        fail("Moneo could not start", error);
      }
    })().finally(() => { booting = undefined; });
    return booting;
  }

  async function showApp(visible: boolean) {
    window ??= createAppWindow(port, {
      onClose: event => {
        if (quitting) return;
        // Closing keeps Moneo running in the tray: background jobs and phone access keep working.
        event.preventDefault();
        window?.hide();
        if (!readSettings().trayNoticeShown && Notification.isSupported()) {
          new Notification({ title: "Moneo is still running", body: "Background syncs and phone access keep working. Open Moneo or quit it from its icon in the tray." }).show();
          updateSettings({ trayNoticeShown: true });
        }
      },
      // Windows ends the session through the window; finish cleanly within the time it gives.
      onSessionEnd: () => void quit(),
    });
    // The server is up; a page that navigates on during this first load (a redirect, a click) is not a failed start.
    await window.loadURL(`http://localhost:${port}/`).catch(error => log(`First page load: ${message(error)}`));
    if (visible) window.show();
  }

  function openWindow() {
    if (window && !booting && !failed) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    } else focusSetup();
  }

  // Backups: one a day while Moneo runs, checked hourly so a sleeping computer catches up.
  function scheduleBackups() {
    const check = async () => {
      const last = Date.parse(readSettings().lastBackupAt ?? "");
      if (Number.isFinite(last) && Date.now() - last < 24 * 3_600_000) return;
      await backUp("daily", false);
    };
    clearInterval(backupTimer);
    backupTimer = setInterval(check, 3_600_000);
    void check();
  }

  async function backUp(reason: string, notify: boolean) {
    if (!backend) return null;
    try {
      const folder = await backup(paths, reason, { automatic: reason === "daily" });
      updateSettings({ lastBackupAt: new Date().toISOString() });
      log(`Backup (${reason}) written to ${folder}`);
      if (notify && Notification.isSupported()) new Notification({ title: "Moneo backed up", body: folder }).show();
      return folder;
    } catch (error) {
      log(`Backup (${reason}) failed: ${message(error)}`);
      if (notify) dialog.showErrorBox("Backup failed", message(error));
      return null;
    }
  }

  async function restoreBackup() {
    mkdirSync(backupsDir(), { recursive: true });
    const picked = await dialog.showOpenDialog({ title: "Restore Moneo from a backup", defaultPath: backupsDir(), properties: ["openDirectory"] });
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return;
    const { response } = await dialog.showMessageBox({
      type: "warning", buttons: ["Restore", "Cancel"], defaultId: 1, cancelId: 1, title: "Restore from backup",
      message: `Restore Moneo from ${path.basename(folder)}?`,
      detail: "Your current data is replaced by this backup. Moneo backs up the current data first, so you can go back.",
    });
    if (response === 0) await restoreFrom(folder);
  }

  async function restoreFrom(folder: string) {
    busy = true;
    try {
      await booting;
      setSetupState({ phase: "restoring", steps: [], error: undefined });
      window?.hide();
      focusSetup();
      await stopServices();
      await restore(paths, folder);
      log(`Restored from ${folder}`);
    } catch (error) {
      busy = false;
      fail("Restoring the backup failed", error);
      return;
    }
    busy = false;
    await boot("restored");
  }

  async function retry() {
    busy = true;
    await stopServices();
    busy = false;
    await boot("retry");
  }

  // Explicit quit: stop the server, then the database, then exit. Forced after 20 seconds.
  let quitPromise: Promise<void> | undefined;
  function quit() {
    quitPromise ??= (async () => {
      quitting = true;
      log("Quitting");
      const notice = setTimeout(() => { setSetupState({ phase: "stopping", steps: [], error: undefined }); focusSetup(); }, 1_500);
      // A start in progress (the first one creates the database) is let finish, so nothing is left
      // half-started; the 20 seconds count from then.
      if (booting) await Promise.race([booting, new Promise(resolve => setTimeout(resolve, 180_000))]);
      const force = setTimeout(() => { log("Shutdown took too long; exiting"); app.exit(0); }, 20_000);
      await stopServices();
      clearTimeout(notice);
      clearTimeout(force);
      log("Stopped");
      if (relaunchPath) app.relaunch({ execPath: relaunchPath });
      app.exit(0);
    })();
    return quitPromise;
  }

  const trayActions: TrayActions = {
    open: openWindow,
    openInBrowser: () => { if (port) void openExternal(`http://localhost:${port}/`); },
    backUp: () => void backUp("manual", true),
    openBackups: () => { mkdirSync(backupsDir(), { recursive: true }); void shell.openPath(backupsDir()); },
    restore: () => void restoreBackup(),
    quit: () => void quit(),
  };

  app.on("second-instance", (_event, argv) => {
    const hook = argv.find(arg => arg.startsWith("--debug-action="))?.slice("--debug-action=".length);
    if (hook && debug) void runHook(hook);
    else if (argv.includes("--quit")) void quit();
    else openWindow();
  });

  // Test hooks (MONEO_DESKTOP_DEBUG=1 only): the tray menu's actions, and a restore without its dialogs.
  async function runHook(hook: string) {
    log(`Debug action ${hook}`);
    const [name, value] = hook.split(/=(.*)/s);
    if (name === "restore" && value) return restoreFrom(value);
    const action = trayActions[name as keyof typeof trayActions];
    if (action) action();
  }

  app.on("before-quit", event => { event.preventDefault(); void quit(); });
  app.on("window-all-closed", () => { /* keep running in the tray */ });
  app.on("activate", openWindow);

  app.whenReady().then(() => {
    log(`Moneo ${app.getVersion()} starting (home ${paths.home})`);
    lockDownSession();
    registerSetupIpc({ retry: () => void retry(), restore: restoreBackup, quit: () => void quit() });
    createTray(trayActions);
    // macOS and Linux announce shutdown here; delaying lets the database close cleanly.
    // (The event object is passed at runtime though Electron's types omit it.)
    powerMonitor.on("shutdown", (...args: unknown[]) => { (args[0] as Electron.Event | undefined)?.preventDefault(); void quit(); });
    void boot("launch");
  });
}
