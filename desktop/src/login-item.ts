import { app } from "electron";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { customHome, readSettings, updateSettings } from "./paths";

const HIDDEN = "--hidden";

const linuxAutostartFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart", "moneo.desktop");
const linuxExecutable = () => process.env.APPIMAGE || process.execPath;

export function startsAtLogin() {
  if (process.platform === "linux") return existsSync(linuxAutostartFile());
  return app.getLoginItemSettings({ args: [HIDDEN] }).openAtLogin;
}

export function setStartAtLogin(on: boolean) {
  if (process.platform !== "linux") return app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN] });
  const file = linuxAutostartFile();
  if (!on) return rmSync(file, { force: true });
  mkdirSync(path.dirname(file), { recursive: true });
  const executable = linuxExecutable();
  writeFileSync(file, [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Moneo",
    `TryExec=${executable}`,
    `Exec="${executable}" ${HIDDEN}`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n"));
}

export function startAtLoginByDefault() {
  if (!app.isPackaged || customHome() || readSettings().startAtLoginDefaulted) return;
  setStartAtLogin(true);
  updateSettings({ startAtLoginDefaulted: true });
}

export const openedAtLogin = () => process.argv.includes(HIDDEN) || app.getLoginItemSettings().wasOpenedAtLogin === true;
