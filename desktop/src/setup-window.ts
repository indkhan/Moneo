import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Progress } from "./backend";
import { devToolsAllowed, iconPath } from "./app-window";
import { logsDir } from "./paths";

type Step = Parameters<Progress>[0];
export type SetupState = {
  phase: "starting" | "failed" | "stopping" | "restoring";
  firstRun: boolean;
  steps: Step[];
  error?: { summary: string; detail?: string };
};

const page = () => path.join(__dirname, "..", "setup", "index.html");
let window: BrowserWindow | undefined;
let state: SetupState = { phase: "starting", firstRun: false, steps: [] };

export function showSetup(visible = true) {
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      width: 520, height: 440, resizable: false, maximizable: false, show: false, title: "Moneo", icon: iconPath(),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: devToolsAllowed(),
      },
    });
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const created = window;
    if (visible) created.once("ready-to-show", () => created.show());
    void created.loadFile(page());
  } else if (visible) window.show();
  return window;
}

export const setupVisible = () => Boolean(window && !window.isDestroyed() && window.isVisible());

export function focusSetup() {
  const current = showSetup();
  if (current.isMinimized()) current.restore();
  current.show();
  current.focus();
}

export function setSetupState(patch: Partial<SetupState>) {
  state = { ...state, ...patch };
  if (window && !window.isDestroyed()) window.webContents.send("setup:state", state);
}

/** Feeds the backend's Progress callback into the step list. */
export const progress: Progress = step => {
  const steps = state.steps.some(existing => existing.id === step.id)
    ? state.steps.map(existing => existing.id === step.id ? step : existing)
    : [...state.steps, step];
  setSetupState({ steps });
};

export function closeSetup() {
  if (window && !window.isDestroyed()) window.destroy();
  window = undefined;
}

export function registerSetupIpc(actions: { retry(): void; restore(): Promise<void>; quit(): void }) {
  // Only the setup page itself, loaded from the app bundle, may call these.
  const fromSetup = (event: IpcMainInvokeEvent) =>
    Boolean(window && event.sender === window.webContents && event.senderFrame?.url === pathToFileURL(page()).href);
  const handle = (channel: string, run: () => unknown) => ipcMain.handle(channel, async event => {
    if (!fromSetup(event)) throw new Error("Not allowed");
    return run();
  });
  handle("setup:state", () => state);
  handle("setup:retry", () => actions.retry());
  handle("setup:open-logs", () => shell.openPath(logsDir()));
  handle("setup:restore", () => actions.restore());
  handle("setup:quit", () => actions.quit());
}
