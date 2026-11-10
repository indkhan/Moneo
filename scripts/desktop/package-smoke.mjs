// Smoke test of the PACKAGED desktop app (after npm run desktop:dist). Uses a temporary Moneo home,
// so it never touches the owner's data, and logs external links instead of opening a browser.
//   node scripts/desktop/package-smoke.mjs [path to the executable]
// Playwright drives the app over the Chrome DevTools protocol: the packaged app turns off Node's
// --inspect flag (a security fuse), which Playwright's _electron.launch needs.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const release = path.join(root, "desktop", "release");
const defaultExe = {
  win32: path.join(release, "win-unpacked", "Moneo.exe"),
  darwin: path.join(release, process.arch === "arm64" ? "mac-arm64" : "mac", "Moneo.app", "Contents", "MacOS", "Moneo"),
  linux: path.join(release, "linux-unpacked", "moneo"),
}[process.platform];
const exe = path.resolve(process.argv[2] ?? defaultExe);
if (!existsSync(exe)) { console.error(`No packaged app at ${exe}. Run npm run desktop:build && npm run desktop:dist first.`); process.exit(1); }

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const until = async (what, test, timeout) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await test().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
};
const freePort = () => new Promise(resolve => { const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Every process started from the app, or naming its home folder (pg_ctl's postgres outlives its parent).
function processesOf(mainPid, home) {
  const rows = process.platform === "win32"
    ? JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", maxBuffer: 64 << 20 }))
      .map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, name: row.Name, command: row.CommandLine ?? "" }))
    : execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n").map(line => {
      const [, pid, ppid, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return { pid: Number(pid), ppid: Number(ppid), name: path.basename(command.split(" ")[0]), command };
    });
  const found = new Map(rows.filter(row => row.pid === mainPid || row.command.toLowerCase().includes(home.toLowerCase())).map(row => [row.pid, row]));
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (found.has(row.ppid) && !found.has(row.pid)) { found.set(row.pid, row); grew = true; }
  }
  return [...found.values()];
}

const user32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);'`;
const win32 = command => execFileSync("powershell.exe", ["-NoProfile", "-Command", `${user32}; ${command}`], { encoding: "utf8" }).trim();

const fuses = await getCurrentFuseWire(exe);
const fuseOff = option => fuses[option] === FuseState.DISABLE;
const fuseOn = option => fuses[option] === FuseState.ENABLE;
check("fuses: RunAsNode, NODE_OPTIONS and --inspect off; cookie encryption, asar-only and asar integrity on",
  fuseOff(FuseV1Options.RunAsNode) && fuseOff(FuseV1Options.EnableNodeOptionsEnvironmentVariable) && fuseOff(FuseV1Options.EnableNodeCliInspectArguments)
  && fuseOn(FuseV1Options.EnableCookieEncryption) && fuseOn(FuseV1Options.OnlyLoadAppFromAsar)
  && (process.platform === "linux" || fuseOn(FuseV1Options.EnableEmbeddedAsarIntegrityValidation)));

const home = mkdtempSync(path.join(os.tmpdir(), "moneo-desktop-smoke-"));
const externalLog = path.join(os.tmpdir(), `moneo-desktop-smoke-${process.pid}-external.log`);
writeFileSync(externalLog, "");
const env = { ...process.env, MONEO_DESKTOP_HOME: home, MONEO_DESKTOP_OPEN_EXTERNAL_LOG: externalLog };
const cdpPort = await freePort();
const app = spawn(exe, [`--remote-debugging-port=${cdpPort}`], { env, stdio: "ignore" });
let exited = false;
app.on("exit", () => { exited = true; });
let seen = [];
let browser;

try {
  // The window list over plain HTTP sees each window as soon as it exists.
  const listed = async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).map(target => target.url);
  await until("the setup window", async () => (await listed()).some(url => url.endsWith("/setup/index.html")), 30_000);
  check("setup window appears", true);
  await until("the app window", async () => (await listed()).some(url => /^http:\/\/localhost:\d+\//.test(url)), 240_000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0];
  const appPage = await until("the app page", async () => context.pages().find(page => /^http:\/\/localhost:\d+\//.test(page.url())), 10_000);
  await appPage.waitForLoadState("load");
  const port = Number(new URL(appPage.url()).port);
  const realBackend = existsSync(path.join(home, "config.json"));
  const landed = new URL(appPage.url()).pathname;
  const text = await appPage.locator("body").innerText();
  check(`app window loads ${realBackend ? "Home" : "(stub backend)"}`, realBackend ? landed === "/" && !/could not sign you in/i.test(text) : /Moneo/.test(text), `${appPage.url()} on port ${port}`);
  check("setup window closed after start", !(await listed()).some(url => url.endsWith("/setup/index.html")));

  const external = "https://example.com/moneo-desktop-smoke";
  await appPage.evaluate(url => { window.location.assign(url); }, external);
  await until("the external link in the log", async () => readFileSync(externalLog, "utf8").includes(external), 10_000);
  check("external navigation goes to the system browser, not the window", new URL(appPage.url()).hostname === "localhost");
  const popup = "https://example.org/moneo-desktop-popup";
  await appPage.evaluate(url => { window.open(url, "_blank"); }, popup);
  await until("the popup in the log", async () => readFileSync(externalLog, "utf8").includes(popup), 10_000);
  check("window.open goes to the system browser", context.pages().every(page => !page.url().includes("example.org")));

  seen = processesOf(app.pid, home);
  console.log(`  processes: ${seen.map(row => `${row.name}#${row.pid}`).join(", ")}`);

  // Windows: the message the title bar's close button sends. Elsewhere: the page asks to close.
  if (process.platform === "win32") {
    const handle = win32(`(Get-Process -Id ${app.pid}).MainWindowHandle`);
    win32(`[W.U]::PostMessage([IntPtr]${handle}, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)`);
    await until("the window to hide", async () => win32(`[W.U]::IsWindowVisible([IntPtr]${handle})`) === "False", 10_000);
  } else {
    await appPage.evaluate(() => window.close());
    await until("the window to hide", async () => await appPage.evaluate(() => document.visibilityState) === "hidden", 10_000);
  }
  const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: "Bearer smoke" } });
  check("closing the window hides it and the server keeps answering", !exited && health.ok, `health ${health.status}`);

  // Explicit quit, as a second launch with --quit (what the tray's Quit does in-process).
  spawn(exe, ["--quit"], { env, stdio: "ignore" });
  await until("Moneo to exit", async () => exited, 40_000);
  const left = seen.filter(row => alive(row.pid));
  check("explicit quit stops every process", left.length === 0, left.map(row => `${row.name}#${row.pid}`).join(", "));
  const answering = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => true, () => false);
  check("the server port is closed after quit", !answering);
} catch (error) {
  check("smoke run", false, error.message);
} finally {
  await browser?.close().catch(() => {});
  // Only processes this run started.
  for (const row of seen) if (alive(row.pid)) try { process.kill(row.pid); } catch { /* gone */ }
  if (!exited) app.kill();
  const log = path.join(home, "logs", "main.log");
  if (results.some(result => !result.ok) && existsSync(log)) console.log(`--- main.log ---\n${readFileSync(log, "utf8").slice(-4000)}`);
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  rmSync(externalLog, { force: true });
}

const failed = results.filter(result => !result.ok).length;
console.log(failed ? `${failed} check(s) failed` : "All desktop smoke checks passed");
process.exit(failed ? 1 : 0);
