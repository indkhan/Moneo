import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const applicationDirectory = (root) => join(root, ".data", "application");
/** @param {unknown} [fallback] */
export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}
export const preferences = root => readJson(join(applicationDirectory(root), "preferences.json"), { openBrowser: true, checkUpdates: false });

const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const desktop = value => '"' + value.replace(/[\\"`$]/g, "\\$&").replaceAll("\\", "\\\\").replaceAll("%", "%%") + '"';

/** User-level sign-in registration: no admin rights, shell, or system-wide service.
 * @param {Record<string, string | undefined>} env
 */
export function startupEntry(root, platform = process.platform, home = homedir(), env = process.env, node = process.execPath) {
  root = resolve(root);
  if ([root, node].some(value => /[\r\n\0]/.test(value))) throw new Error("The installation path cannot contain line breaks.");
  const id = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const launcher = join(root, "scripts", "application-launcher.mjs");
  if (platform === "win32") {
    if (!env.APPDATA) throw new Error("Windows AppData is unavailable.");
    if ([node, launcher].some(value => /["%]/.test(value))) throw new Error("Move Moneo to a path without quotes or percent signs before enabling startup.");
    const command = `"${node}" "${launcher}" --login`;
    return { path: join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `Moneo-${id}.vbs`), content: `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n` };
  }
  if (platform === "darwin") return {
    path: join(home, "Library", "LaunchAgents", `local.moneo.${id}.plist`),
    content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>local.moneo.${id}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(launcher)}</string><string>--login</string></array><key>RunAtLoad</key><true/></dict></plist>\n`,
  };
  if (platform === "linux") return {
    path: join(env.XDG_CONFIG_HOME || join(home, ".config"), "autostart", `moneo-${id}.desktop`),
    content: `[Desktop Entry]\nType=Application\nName=Moneo\nExec=${desktop(node)} ${desktop(launcher)} --login\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`,
  };
  throw new Error("Automatic startup supports Windows, macOS and Linux desktop sessions.");
}
export const startupEnabled = root => existsSync(startupEntry(root).path);
export function setStartup(root, enabled) {
  const entry = startupEntry(root);
  if (enabled) {
    mkdirSync(dirname(entry.path), { recursive: true });
    writeFileSync(entry.path, entry.content, { mode: 0o600 });
  } else rmSync(entry.path, { force: true });
}

export function localApplicationRequest(headers) {
  const local = value => /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(value ?? "");
  return local(headers.get("host")) && (!headers.has("x-forwarded-host") || local(headers.get("x-forwarded-host"))) && !headers.has("tailscale-funnel-request");
}

/** Runtime file is only a discovery hint; a live authenticated response proves ownership. */
/** @param {unknown} [body] */
export async function launcherRequest(root, path = "/status", body = undefined) {
  const runtime = readJson(join(applicationDirectory(root), "runtime.json"));
  if (!runtime || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 || typeof runtime.token !== "string") throw new Error("Start Moneo with npm start to use the application controls.");
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${runtime.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "The launcher could not complete that request.");
  return result;
}
