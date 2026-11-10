import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

// Bundled resources: next to app.asar when packaged, desktop/.build while developing.
export const resources = () => app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), ".build");

/** Per-user data folder. Tests point MONEO_DESKTOP_HOME at a temporary folder. Call before `ready`. */
export function setupHome() {
  const home = process.env.MONEO_DESKTOP_HOME ? path.resolve(process.env.MONEO_DESKTOP_HOME) : app.getPath("userData");
  app.setPath("userData", home);
  // Keep Chromium's own files (cookies, caches) apart from the database and backups.
  app.setPath("sessionData", path.join(home, "chromium"));
  mkdirSync(path.join(home, "logs"), { recursive: true });
  app.setAppLogsPath(path.join(home, "logs"));
  return home;
}

export const home = () => app.getPath("userData");
export const logsDir = () => path.join(home(), "logs");
export const backupsDir = () => path.join(home(), "backups");
export const dataDir = () => path.join(home(), "data");

/** platform-arch folder of the bundled native tools, e.g. win-x64. */
export const platformKey = () => `${process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"}-${process.arch}`;

export function log(message: string, file = "main.log") {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { appendFileSync(path.join(logsDir(), file), line); } catch { /* logging must never stop Moneo */ }
  if (!app.isPackaged) process.stdout.write(line);
}

// The shell's own settings. The backend keeps its secrets in config.json; these are kept apart so the two never race.
export type ShellSettings = { port?: number; trayNoticeShown?: boolean; lastBackupAt?: string; bankCertificateTrusted?: boolean };
const settingsFile = () => path.join(home(), "shell.json");

export function readSettings(): ShellSettings {
  try { return existsSync(settingsFile()) ? JSON.parse(readFileSync(settingsFile(), "utf8")) as ShellSettings : {}; } catch { return {}; }
}

export function updateSettings(patch: ShellSettings) {
  const next = { ...readSettings(), ...patch };
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
