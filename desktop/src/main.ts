import { app, BrowserWindow, dialog, Notification, powerMonitor, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { backup, restore, startBackend, type BackendPaths, type RunningBackend } from "./backend";
import { createAppWindow, lockDownSession, openExternal, setAppPort } from "./app-window";
import { ensureBankCertificate } from "./certificate";
import { NextServer } from "./next-server";
import { backupsDir, home, log, readSettings, resources, setupHome, updateSettings } from "./paths";
import { choosePort } from "./port";
import { closeSetup, focusSetup, progress, registerSetupIpc, setSetupState, showSetup } from "./setup-window";
import { createTray, openedAtLogin } from "./tray";

setupHome();
if (!app.requestSingleInstanceLock()) app.quit();
else main();

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

  function boot() {
    booting ??= (async () => {
      failed = false;
      setSetupState({ phase: "starting", steps: [], error: undefined, firstRun: !existsSync(path.join(paths.home, "config.json")) });
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
        server = new NextServer({ appDir: path.join(paths.resources, "app"), port, env: running.env }, error => fail("The Moneo server keeps stopping", error));
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
    await window.loadURL(`http://localhost:${port}/`);
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
    if (response !== 0) return;
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
    await boot();
  }

  async function retry() {
    busy = true;
    await stopServices();
    busy = false;
    await boot();
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
      app.exit(0);
    })();
    return quitPromise;
  }

  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--quit")) void quit();
    else openWindow();
  });
  app.on("before-quit", event => { event.preventDefault(); void quit(); });
  app.on("window-all-closed", () => { /* keep running in the tray */ });
  app.on("activate", openWindow);

  app.whenReady().then(() => {
    log(`Moneo ${app.getVersion()} starting (home ${paths.home})`);
    lockDownSession();
    registerSetupIpc({ retry: () => void retry(), restore: restoreBackup, quit: () => void quit() });
    createTray({
      open: openWindow,
      openInBrowser: () => { if (port) void openExternal(`http://localhost:${port}/`); },
      backUp: () => void backUp("manual", true),
      openBackups: () => { mkdirSync(backupsDir(), { recursive: true }); void shell.openPath(backupsDir()); },
      restore: () => void restoreBackup(),
      quit: () => void quit(),
    });
    // macOS and Linux announce shutdown here; delaying lets the database close cleanly.
    // (The event object is passed at runtime though Electron's types omit it.)
    powerMonitor.on("shutdown", (...args: unknown[]) => { (args[0] as Electron.Event | undefined)?.preventDefault(); void quit(); });
    void boot();
  });
}
