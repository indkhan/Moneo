import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

export const resources = () => app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), ".build");

export function setupHome() {
  const home = process.env.MONEO_DESKTOP_HOME ? path.resolve(process.env.MONEO_DESKTOP_HOME) : app.getPath("userData");
  app.setPath("userData", home);
  app.setPath("sessionData", path.join(home, "chromium"));
  mkdirSync(path.join(home, "logs"), { recursive: true });
  app.setAppLogsPath(path.join(home, "logs"));
  return home;
}

export const home = () => app.getPath("userData");
export const logsDir = () => path.join(home(), "logs");
export const backupsDir = () => path.join(home(), "backups");
export const dataDir = () => path.join(home(), "data");

export const platformKey = () => `${process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"}-${process.arch}`;

export function log(message: string, file = "main.log") {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { appendFileSync(path.join(logsDir(), file), line); } catch {}
  if (!app.isPackaged) process.stdout.write(line);
}

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
