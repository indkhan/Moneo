import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ isPackaged: true, setLoginItemSettings: vi.fn(), getLoginItemSettings: vi.fn(), getPath: () => process.env.TEST_SHELL_HOME }));
vi.mock("electron", () => ({ app: electron }));
import { setStartAtLogin, startAtLoginByDefault, startsAtLogin } from "./login-item";

const platform = process.platform;
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "moneo-login-"));
  vi.stubEnv("TEST_SHELL_HOME", scratch);
  vi.stubEnv("MONEO_DESKTOP_HOME", "");
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

it("turns start at sign-in on once for new and updated installs, and never again after the owner turns it off", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  startAtLoginByDefault();
  expect(electron.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, args: ["--hidden"] });

  setStartAtLogin(false);
  electron.setLoginItemSettings.mockClear();
  startAtLoginByDefault();
  expect(electron.setLoginItemSettings).not.toHaveBeenCalled();
});

it("leaves sign-in alone for a run with its own data folder, since sign-in would start the owner's", () => {
  vi.stubEnv("MONEO_DESKTOP_HOME", scratch);
  startAtLoginByDefault();
  expect(electron.setLoginItemSettings).not.toHaveBeenCalled();
});

it("starts hidden at sign-in on Linux through an autostart entry the owner can remove", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.stubEnv("XDG_CONFIG_HOME", scratch);
  vi.stubEnv("APPIMAGE", "/home/owner/Apps/Moneo.AppImage");

  setStartAtLogin(true);
  expect(startsAtLogin()).toBe(true);
  expect(readFileSync(path.join(scratch, "autostart", "moneo.desktop"), "utf8")).toContain('Exec="/home/owner/Apps/Moneo.AppImage" --hidden');

  setStartAtLogin(false);
  expect(startsAtLogin()).toBe(false);
});
