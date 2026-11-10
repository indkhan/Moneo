// Child processes, logs, ports and health checks for the native services.
import { spawn, fork as nodeFork, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
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
export function runProgram(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; log?: WriteStream } = {}) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(file, args, { env: options.env ?? process.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => { output += chunk.toString(); options.log?.write(chunk); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = options.timeoutMs ? setTimeout(() => { child.kill(); reject(new Error(`${path.basename(file)} timed out after ${options.timeoutMs} ms\n${output}`)); }, options.timeoutMs) : undefined;
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve({ code, output }); });
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

// The executable name of a running process, used before touching a PID left by an earlier run.
export async function processName(pid: number): Promise<string | undefined> {
  if (!isAlive(pid)) return undefined;
  if (process.platform === "win32") {
    const { output } = await runProgram("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    return output.match(/^"([^"]+)"/m)?.[1]?.toLowerCase();
  }
  const { output } = await runProgram("ps", ["-p", String(pid), "-o", "comm="]);
  return path.basename(output.trim()).toLowerCase() || undefined;
}

// PIDs of the services this backend started, so a later start can end the ones a crash left behind.
export class PidFile {
  constructor(private file: string) {}
  async read(): Promise<{ service: string; pid: number; name: string }[]> {
    if (!existsSync(this.file)) return [];
    try { return JSON.parse(await fs.readFile(this.file, "utf8")); } catch { return []; }
  }
  async write(entries: { service: string; pid: number; name: string }[]) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(entries));
  }
  // Kills a recorded process only while its executable name still matches what was started.
  async killStale(log: (line: string) => void) {
    for (const entry of await this.read()) {
      const name = await processName(entry.pid);
      if (name && name === entry.name.toLowerCase()) {
        log(`Stopping ${entry.service} (pid ${entry.pid}) left from an earlier run`);
        try { process.kill(entry.pid); } catch { /* already gone */ }
      }
    }
    await fs.rm(this.file, { force: true });
  }
}
