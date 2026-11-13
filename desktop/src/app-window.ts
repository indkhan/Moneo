import { app, BrowserWindow, dialog, session, shell, type WebContents } from "electron";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { trustBankCertificate } from "./certificate";
import { isAppUrl, isBankConsent, isExternalAllowed } from "./navigation";
import { log, readSettings, updateSettings } from "./paths";

export const devToolsAllowed = () => !app.isPackaged || process.env.MONEO_DESKTOP_DEBUG === "1";
export const iconPath = () => path.join(__dirname, "..", "icons", "icon.png");

let appPort = 0;
let reloadOnFocus = false;

/** Opens an address in the system browser. Tests log it to a file instead. */
export async function openExternal(url: string) {
  if (!isExternalAllowed(url, appPort)) { log("Blocked opening an address that is neither https nor Moneo"); return; }
  if (isBankConsent(url) && !readSettings().bankCertificateTrusted) await offerBankTrust();
  const testLog = process.env.MONEO_DESKTOP_OPEN_EXTERNAL_LOG;
  if (testLog) appendFileSync(testLog, `${url}\n`);
  else await shell.openExternal(url);
}

// The bank sends the owner back to https://localhost:3443; without this the browser warns there.
async function offerBankTrust() {
  if (process.env.MONEO_DESKTOP_OPEN_EXTERNAL_LOG) return;
  const { response } = await dialog.showMessageBox({
    type: "info", buttons: ["Continue", "Skip"], defaultId: 0, cancelId: 1, title: "Connect your bank",
    message: "Allow your bank to send you back to Moneo",
    detail: "After you approve access at your bank, it returns you to Moneo through a secure address on this computer. "
      + "Moneo made a certificate for that address that only this computer uses. Your computer will now ask once whether to trust it.",
  });
  if (response === 0 && await trustBankCertificate()) updateSettings({ bankCertificateTrusted: true });
}

/** Allows only the microphone (voice calls) and copying, and only for Moneo's own pages. */
export function lockDownSession() {
  const ours = (url: string | undefined) => Boolean(url && isAppUrl(url, appPort));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const audioOnly = permission === "media" && "mediaTypes" in details && (details.mediaTypes ?? []).every(type => type === "audio");
    callback(ours(details.requestingUrl) && (audioOnly || permission === "clipboard-sanitized-write"));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) =>
    ours(origin) && (permission === "media" || permission === "clipboard-sanitized-write"));
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: "deny" }; });
    contents.on("will-attach-webview", event => event.preventDefault());
  });
}

function guardNavigation(contents: WebContents) {
  const leave = (event: Electron.Event, url: string) => {
    if (isAppUrl(url, appPort)) return;
    event.preventDefault();
    // Sign-ins (ChatGPT, banks, Scalable) run in the system browser and come back to Moneo's loopback callbacks.
    reloadOnFocus = true;
    void openExternal(url);
  };
  contents.on("will-navigate", event => leave(event, event.url));
  contents.on("will-redirect", event => { if (event.isMainFrame) leave(event, event.url); });
}

export function createAppWindow(port: number, hooks: { onClose(event: Electron.Event): void; onSessionEnd(): void }) {
  appPort = port;
  const window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, minHeight: 500, show: false, title: "Moneo", icon: iconPath(),
    backgroundColor: "#0f1011", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: devToolsAllowed(), spellcheck: false },
  });
  guardNavigation(window.webContents);
  window.on("close", hooks.onClose);
  window.on("session-end", hooks.onSessionEnd);
  // Back from a sign-in in the browser: show what it changed.
  window.on("focus", () => {
    if (!reloadOnFocus) return;
    reloadOnFocus = false;
    window.webContents.reload();
  });
  return window;
}

export const setAppPort = (port: number) => { appPort = port; };

/** Shows a sign-in's result (from the system browser) in the app window and brings it to the front. */
export async function showReturn(window: BrowserWindow, returnPath: string) {
  reloadOnFocus = false;
  if (window.isMinimized()) window.restore();
  window.show();
  // Windows only flashes the taskbar for focus() from a background app; topmost for a moment raises it.
  window.setAlwaysOnTop(true);
  window.focus();
  window.setAlwaysOnTop(false);
  // A redirect during the load is not a failure; the window shows whatever the page became.
  await window.loadURL(`http://localhost:${appPort}${returnPath}`).catch(error => log(`Returning to ${returnPath}: ${error instanceof Error ? error.message : error}`));
}
