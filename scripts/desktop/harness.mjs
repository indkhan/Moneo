// Shared helpers for the packaged-app checks (package-smoke.mjs, package-journey.mjs, package-upgrade.mjs).
// Every run uses temporary Moneo homes, logs external links instead of opening a browser, and only
// ever stops processes it started itself.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const release = path.join(root, "desktop", "release");

export function defaultExe() {
  return {
    win32: path.join(release, "win-unpacked", "Moneo.exe"),
    darwin: path.join(release, process.arch === "arm64" ? "mac-arm64" : "mac", "Moneo.app", "Contents", "MacOS", "Moneo"),
    linux: path.join(release, "linux-unpacked", "moneo"),
  }[process.platform];
}

export const results = [];
export function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  return Boolean(ok);
}
export function summary() {
  const failed = results.filter(result => !result.ok).length;
  console.log(failed ? `${failed} check(s) failed` : `All ${results.length} checks passed`);
  return failed;
}

export async function until(what, test, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await test().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export const freePort = () => new Promise(resolve => { const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

const user32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);'`;
export const powershell = command => execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const win32 = command => powershell(`${user32}; ${command}`);

/** Process table: pid, parent, name, command line. */
function processTable() {
  if (process.platform === "win32") {
    return JSON.parse(powershell("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"))
      .map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, name: row.Name, command: row.CommandLine ?? "" }));
  }
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n").map(line => {
    const [, pid, ppid, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return { pid: Number(pid), ppid: Number(ppid), name: path.basename(command.split(" ")[0]), command };
  });
}

/** Every process started from the app, or naming its home folder (pg_ctl's postgres outlives its parent). */
export function processesOf(mainPid, home) {
  const rows = processTable();
  const found = new Map(rows.filter(row => row.pid === mainPid || row.command.toLowerCase().includes(home.toLowerCase())).map(row => [row.pid, row]));
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (found.has(row.ppid) && !found.has(row.pid) && /^(moneo(?:-qa)?|postgres|pg_ctl|node|conhost)(\.exe)?$/i.test(row.name) && (row.name.toLowerCase() !== "node.exe" || /resources[\\/]app[\\/]/i.test(row.command))) { found.set(row.pid, row); grew = true; }
  }
  return [...found.values()];
}

export function listeningPid(port) {
  if (process.platform !== "win32") return Number(execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0]) || null;
  return Number(powershell(`(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`)) || null;
}

export function tempHome(label) {
  return mkdtempSync(path.join(os.tmpdir(), `moneo-shell-${label}-`));
}

/** A Moneo home plus the processes launched in it. */
export class Desktop {
  constructor(exe, label, extraEnv = {}) {
    this.exe = exe;
    this.home = tempHome(label);
    this.externalLog = path.join(os.tmpdir(), `moneo-shell-${label}-${process.pid}-external.log`);
    writeFileSync(this.externalLog, "");
    this.env = { ...process.env, MONEO_DESKTOP_HOME: this.home, MONEO_DESKTOP_OPEN_EXTERNAL_LOG: this.externalLog, MONEO_DESKTOP_DEBUG: "1", ...extraEnv };
    this.seen = new Map();
  }

  /** Starts the app with a DevTools port (allowed only with MONEO_DESKTOP_DEBUG=1). */
  async launch(args = []) {
    this.cdpPort = await freePort();
    const child = spawn(this.exe, [`--remote-debugging-port=${this.cdpPort}`, "--use-fake-device-for-media-stream", ...args], { env: this.env, stdio: "ignore" });
    this.child = child;
    child.exited = false;
    child.on("exit", code => { child.exited = true; child.code = code; });
    await until("the DevTools endpoint", () => this.targets(), 30_000);
    return child;
  }

  async targets() {
    return (await (await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`)).json());
  }
  async urls() { return (await this.targets()).map(target => target.url); }

  async browser() {
    this.cdp ??= await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
    return this.cdp;
  }

  async page(match, timeout = 240_000) {
    await until(`a window at ${match}`, async () => (await this.urls()).some(url => match.test(url)), timeout);
    const browser = await this.browser();
    return until("its page", async () => browser.contexts().flatMap(context => context.pages()).find(page => match.test(page.url())), 15_000);
  }

  appPage(timeout) { return this.page(/^http:\/\/localhost:\d+\//, timeout); }
  setupPage(timeout = 30_000) { return this.page(/\/setup\/index\.html$/, timeout); }

  /** Remembers this launch's processes so the checks (and cleanup) can account for them. */
  snapshot() {
    for (const row of processesOf(this.child.pid, this.home)) this.seen.set(row.pid, row);
    return [...this.seen.values()];
  }

  /** A second launch: forwards its arguments to the running app, then exits. */
  async second(args) {
    const child = spawn(this.exe, args, { env: this.env, stdio: "ignore" });
    await new Promise(resolve => child.on("exit", resolve));
  }

  async quit() {
    await this.cdp?.close().catch(() => {});
    this.cdp = undefined;
    await this.second(["--quit"]);
    await until("Moneo to exit", async () => this.child.exited, 60_000);
  }

  log(name = "main.log") {
    const file = path.join(this.home, "logs", name);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  external() { return readFileSync(this.externalLog, "utf8"); }
  settings() { return JSON.parse(readFileSync(path.join(this.home, "shell.json"), "utf8")); }

  mainWindow() {
    return win32(`(Get-Process -Id ${this.child.pid}).MainWindowHandle`);
  }
  /** Windows: the message the title bar's close button sends. */
  closeWindow(handle) { win32(`[W.U]::PostMessage([IntPtr]${handle}, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)`); }
  windowVisible(handle) { return win32(`[W.U]::IsWindowVisible([IntPtr]${handle})`) === "True"; }

  async cleanup({ keepHome = false } = {}) {
    await this.cdp?.close().catch(() => {});
    if (this.child && !this.child.exited) await this.quit().catch(() => {});
    // Only processes these launches started.
    const current = new Map(processTable().map(row => [row.pid, row]));
    for (const row of this.snapshotSafe()) if (current.get(row.pid)?.command === row.command && alive(row.pid)) try { process.kill(row.pid); } catch { /* gone */ }
    if (results.some(result => !result.ok)) {
      for (const name of ["main.log", "next.log"]) {
        const text = this.log(name);
        if (text) console.log(`--- ${name} (${this.home}) ---\n${text.slice(-3000)}`);
      }
    }
    if (!keepHome) rmSync(this.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    rmSync(this.externalLog, { force: true });
  }

  snapshotSafe() {
    try { if (this.child) this.snapshot(); } catch { /* process table unavailable */ }
    return [...this.seen.values()];
  }
}

/** Imports a CSV through the app's own API, as the import page does once the columns are chosen, and waits for it. */
export async function importCsv(page, { filename, csv, accountName }) {
  const mapping = { accountName, currencyCode: "EUR", dateColumn: "date", descriptionColumn: "description", amountColumn: "amount", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot" };
  const origin = new URL(page.url()).origin;
  const response = await page.request.post(`${origin}/api/imports/confirm`, { multipart: { file: { name: filename, mimeType: "text/csv", buffer: Buffer.from(csv) }, mapping: JSON.stringify(mapping) } });
  if (!response.ok()) throw new Error(`import ${filename}: ${response.status()} ${await response.text()}`);
  const { importId } = await response.json();
  await until(`import ${filename} to complete`, async () => {
    const list = await (await page.request.get(`${origin}/api/imports`)).json();
    return list.find(row => row.id === importId)?.status === "completed";
  }, 120_000);
  return importId;
}

export async function transactionsText(page) {
  const origin = new URL(page.url()).origin;
  // Right after a (re)start the shell's own first load may still be running and cancel this one.
  for (let attempt = 0; ; attempt++) {
    try { await page.goto(`${origin}/money/transactions`); break; }
    catch (error) { if (attempt >= 4 || !/ERR_ABORTED/.test(error.message)) throw error; await page.waitForLoadState("load").catch(() => {}); }
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  return page.locator("main").innerText();
}

export const statement = (rows) => ["date,description,amount", ...rows.map(([date, description, amount]) => `${date},${description},${amount}`), ""].join("\n");
