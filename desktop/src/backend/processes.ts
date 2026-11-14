// Child processes, logs, ports and health checks for the native services.
import { spawn, fork as nodeFork, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, realpathSync, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

// A forked Node process: Electron's utilityProcess.fork in the app, child_process.fork elsewhere.
export interface ForkedProcess {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(): boolean;
  once(event: "exit", listener: (code: number | null) => void): unknown;
}
export type ForkFn = (modulePath: string, args: string[], options: { env: Record<string, string>; cwd: string; serviceName: string }) => ForkedProcess;

// Electron has no ELECTRON_RUN_AS_NODE in Moneo (fuses disable it), so a Node child is a utilityProcess.
export const defaultFork: ForkFn = (modulePath, args, options) => {
  if (process.versions.electron) {
    // Loaded lazily so the module also runs under plain Node.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { utilityProcess } = require("electron") as typeof import("electron");
    return utilityProcess.fork(modulePath, args, { env: options.env, cwd: options.cwd, stdio: "pipe", serviceName: options.serviceName }) as unknown as ForkedProcess;
  }
  return nodeFork(modulePath, args, { env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }) as ForkedProcess;
};

export const exe = process.platform === "win32" ? ".exe" : "";

export function platformKey() {
  const keys: Record<string, string> = { "win32-x64": "win-x64", "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "linux-x64": "linux-x64" };
  const key = keys[`${process.platform}-${process.arch}`];
  if (!key) throw new Error(`Moneo Desktop has no native backend for ${process.platform}-${process.arch}`);
  return key;
}

// Appends to <logs>/<name>.log, rotating to .1 once it passes 10 MB at open.
export async function openLog(logs: string, name: string): Promise<WriteStream> {
  await fs.mkdir(logs, { recursive: true });
  const file = path.join(logs, `${name}.log`);
  const stat = await fs.stat(file).catch(() => undefined);
  if (stat && stat.size > 10 * 1024 * 1024) await fs.rename(file, `${file}.1`);
  return createWriteStream(file, { flags: "a" });
}

export function pipeTo(log: WriteStream, child: { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null }) {
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
}

// Runs a program to its exit. Resolves on "exit", not "close": pg_ctl start leaves a server
// running that may hold inherited handles open.
export function runProgram(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; log?: WriteStream; waitForClose?: boolean } = {}) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(file, args, { env: options.env ?? process.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => { output += chunk.toString(); options.log?.write(chunk); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = options.timeoutMs ? setTimeout(() => { child.kill(); reject(new Error(`${path.basename(file)} timed out after ${options.timeoutMs} ms\n${output}`)); }, options.timeoutMs) : undefined;
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once(options.waitForClose ? "close" : "exit", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

export async function mustRun(file: string, args: string[], options: Parameters<typeof runProgram>[2] = {}) {
  const result = await runProgram(file, args, options);
  if (result.code !== 0) throw new Error(`${path.basename(file)} ${args[0] ?? ""} failed (exit ${result.code}):\n${result.output.trim()}`);
  return result.output;
}

export function spawnService(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  return spawn(file, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

export function portIsFree(port: number) {
  return new Promise<boolean>(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export async function preferredPort(port: number) {
  return (await portIsFree(port)) ? port : freePort();
}

// Polls until check() resolves true; rejects with the last error after timeoutMs.
export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number, exited?: () => string | undefined) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    const gone = exited?.();
    if (gone) throw new Error(`${what} stopped while starting: ${gone}`);
    try { if (await check()) return; } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(`${what} did not become ready within ${timeoutMs / 1000} s${last ? ` (${(last as Error).message})` : ""}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export async function httpOk(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  await response.body?.cancel();
  return response.ok;
}

export function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export type ProcessInfo = { exe?: string; commandLine?: string };

// Executable path and command line of running processes, read before touching a PID left by an
// earlier run. A PID that is gone, or whose details cannot be read, is missing from the result.
export async function processInfo(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const result = new Map<number, ProcessInfo>();
  const alive = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0 && isAlive(pid));
  if (!alive.length) return result;
  if (process.platform === "win32") {
    const filter = alive.map(pid => `ProcessId=${pid}`).join(" OR ");
    const { output } = await runProgram("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`], { timeoutMs: 30_000 });
    const parsed = output.trim() ? JSON.parse(output) : [];
    for (const row of Array.isArray(parsed) ? parsed : [parsed])
      result.set(row.ProcessId, { exe: row.ExecutablePath ?? undefined, commandLine: row.CommandLine ?? undefined });
    return result;
  }
  for (const pid of alive) {
    if (process.platform === "linux") {
      const exe = await fs.readlink(`/proc/${pid}/exe`).catch(() => undefined);
      const commandLine = await fs.readFile(`/proc/${pid}/cmdline`, "utf8").then(text => text.split(String.fromCharCode(0)).join(" ")).catch(() => undefined);
      result.set(pid, { exe, commandLine });
    } else {
      // macOS: comm is the full path of the executable.
      const exe = (await runProgram("ps", ["-p", String(pid), "-o", "comm="])).output.trim() || undefined;
      const commandLine = (await runProgram("ps", ["-p", String(pid), "-o", "args="])).output.trim() || undefined;
      result.set(pid, { exe, commandLine });
    }
  }
  return result;
}

const comparable = (file: string) => {
  let resolved = path.resolve(file);
  try { resolved = realpathSync.native(resolved); } catch { /* compare as given */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

// True when file is dir itself or inside it, after resolving links (junctions included).
export function isInside(file: string | undefined, dir: string) {
  if (!file) return false;
  const relative = path.relative(comparable(dir), comparable(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Whether a command line names file (separators and, on Windows, case ignored).
export const mentions = (commandLine: string | undefined, file: string) => {
  const normalize = (text: string) => (process.platform === "win32" ? text.toLowerCase() : text).replaceAll("\\", "/");
  return commandLine !== undefined && normalize(commandLine).includes(normalize(path.resolve(file)));
};

export const samePath = (a: string | undefined, b: string) => a !== undefined && comparable(a) === comparable(b);

async function terminate(pid: number) {
  try { process.kill(pid); } catch { return; }
  const deadline = Date.now() + 5000;
  while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (isAlive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

export type PidEntry = { service: string; pid: number; exe: string; script?: string };

// PIDs and executables of the services this backend started (<home>/run/services.json), so a start
// after a crash or a force-quit can end the ones left behind.
export class PidFile {
  constructor(private file: string) {}
  async read(): Promise<PidEntry[]> {
    if (!existsSync(this.file)) return [];
    try { return (JSON.parse(await fs.readFile(this.file, "utf8")) as PidEntry[]).filter(entry => entry.exe && entry.pid); } catch { return []; }
  }
  async write(entries: PidEntry[]) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(entries));
  }
  // Ends a recorded process only while it is alive and still the program that was started:
  // its executable is the recorded one and lies inside the bundled backend (GoTrue, PostgREST), or,
  // for a Node service, it is the recorded Node/Electron binary running the recorded script from the
  // bundle. Anything else with a reused PID is left alone; nothing is ever matched by name.
  async killStale(bundle: string[], log: (line: string) => void) {
    const bundled = (file: string | undefined) => bundle.some(dir => isInside(file, dir));
    const entries = await this.read();
    const info = await processInfo(entries.map(entry => entry.pid));
    for (const entry of entries) {
      const found = info.get(entry.pid);
      if (!found) continue;
      const ours = samePath(found.exe, entry.exe) && (entry.script
        ? bundled(entry.script) && mentions(found.commandLine, entry.script)
        : bundled(found.exe));
      if (!ours) { log(`Leaving pid ${entry.pid} alone: it is no longer ${entry.service} (${found.exe ?? "unknown executable"})`); continue; }
      log(`Stopping ${entry.service} (pid ${entry.pid}) left running by an earlier session`);
      await terminate(entry.pid);
    }
    await fs.rm(this.file, { force: true });
  }
}
