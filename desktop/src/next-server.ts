import { utilityProcess, type UtilityProcess } from "electron";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { log, logsDir } from "./paths";

// Host variables the server needs to run on each OS. Nothing else from the shell's environment is
// passed on, so a developer's NEXT_PUBLIC_*, NODE_OPTIONS or .env-style variables never leak in.
const HOST_VARS = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "LANG", "LC_ALL", "TZ"];

export type NextServerOptions = { appDir: string; port: number; env: Record<string, string> };

const READY_TIMEOUT = 90_000;

/** The Next.js standalone server in a utility process, restarted with backoff when it crashes. */
export class NextServer {
  private child?: UtilityProcess;
  private stopping = false;
  private restarts = 0;
  private restartTimer?: NodeJS.Timeout;
  private output = createWriteStream(path.join(logsDir(), "next.log"), { flags: "a" });
  private recent: string[] = [];

  constructor(private options: NextServerOptions, private onDown: (error: Error) => void) {}

  get url() { return `http://localhost:${this.options.port}`; }
  get pid() { return this.child?.pid; }

  async start() {
    this.stopping = false;
    const startedAt = Date.now();
    const child = this.spawn();
    await this.waitReady(child);
    child.once("exit", code => {
      if (this.stopping || this.child !== child) return;
      log(`Next server exited with ${code}`);
      // A server that ran for a while earns a fresh backoff.
      if (Date.now() - startedAt > 60_000) this.restarts = 0;
      this.scheduleRestart();
    });
  }

  private spawn() {
    const host = Object.fromEntries(HOST_VARS.flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
    const env = {
      ...host,
      ...this.options.env,
      PORT: String(this.options.port),
      HOSTNAME: "127.0.0.1",
      NEXT_PUBLIC_APP_URL: `http://localhost:${this.options.port}`,
      MONEO_DESKTOP: "1",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
    };
    const child = utilityProcess.fork(path.join(this.options.appDir, "server.js"), [], {
      cwd: this.options.appDir, env, stdio: "pipe", serviceName: "Moneo server",
    });
    const record = (chunk: Buffer) => {
      this.output.write(chunk);
      this.recent.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
      this.recent.splice(0, Math.max(0, this.recent.length - 20));
    };
    child.stdout?.on("data", record);
    child.stderr?.on("data", record);
    this.child = child;
    log(`Next server starting on port ${this.options.port}`);
    return child;
  }

  private async waitReady(child: UtilityProcess) {
    let exited: number | null | undefined;
    child.once("exit", code => { exited = code; });
    const deadline = Date.now() + READY_TIMEOUT;
    while (Date.now() < deadline) {
      if (exited !== undefined) throw new Error(`The Moneo server stopped while starting (exit ${exited}).\n${this.recent.slice(-8).join("\n")}`);
      try {
        // The bearer header keeps the proxy from signing the owner in for every probe.
        const response = await fetch(`http://127.0.0.1:${this.options.port}/api/health`, { headers: { authorization: "Bearer readiness" }, signal: AbortSignal.timeout(5_000) });
        if (response.status < 500) { log("Next server is ready"); return; }
      } catch { /* not listening yet */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    child.kill();
    throw new Error(`The Moneo server did not answer within ${READY_TIMEOUT / 1000} seconds.\n${this.recent.slice(-8).join("\n")}`);
  }

  private scheduleRestart() {
    const delay = Math.min(30_000, 1_000 * 2 ** this.restarts++);
    log(`Restarting the Next server in ${delay} ms`);
    this.restartTimer = setTimeout(() => {
      this.start().catch(error => {
        log(`Next server restart failed: ${error instanceof Error ? error.message : error}`);
        if (this.restarts >= 6) this.onDown(error instanceof Error ? error : new Error(String(error)));
        else this.scheduleRestart();
      });
    }, delay);
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = undefined;
    if (!child?.pid) return;
    await new Promise<void>(resolve => {
      const force = setTimeout(resolve, 10_000);
      child.once("exit", () => { clearTimeout(force); resolve(); });
      child.kill();
    });
    log("Next server stopped");
  }
}
