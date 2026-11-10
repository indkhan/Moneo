// Kept outside Next.js so startup and update progress survive stopping the website.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { applicationDirectory, preferences, readJson, writeJson, launcherRequest } from "./application-state.mjs";
import { checkRelease, parseUpdateTarget } from "./application-releases.mjs";
import { installUpdate, prepareUpdate } from "./application-update.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
if (process.env.NEXT_DIST_DIR || process.env.PORT === "3100") throw new Error("Use npm run qa:server for the test backend.");
// Login agents have a smaller PATH than interactive terminals, especially on macOS.
process.env.PATH = [dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", join(homedir(), ".docker", "bin"), ...(process.platform === "win32" ? [join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "resources", "bin")] : []), process.env.PATH || ""].join(delimiter);
const directory = applicationDirectory(root);
mkdirSync(directory, { recursive: true });
const log = message => appendFileSync(join(directory, "launcher.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
const port = Number(process.env.PORT || (process.argv.includes("--login") && readJson(join(directory, "startup.json"))?.port) || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid application port.");
const url = `http://localhost:${port}`;
const login = process.argv.includes("--login");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let stopping = false;
let state = { phase: "starting", message: "Starting Moneo…" };
let pendingUpdate;
const token = randomBytes(32).toString("hex");
const runtimePath = join(directory, "runtime.json");
const lockPath = join(directory, "launcher.lock");

async function performUpdate(input) {
  let target;
  try { target = await prepareUpdate(root, input, command); }
  catch (error) {
    state = { phase: "restored", message: "The update was not started. Moneo is still running.", recovery: error.message };
    return;
  }
  try {
    await installUpdate({ root, target, run: command, stop: stopWebsite, start: startWebsite, status: next => {
      state = next; writeJson(join(directory, "update-status.json"), next);
    } });
  } catch (error) {
    state = { phase: "failed", message: `Update recovery needs attention: ${error.message}`, recovery: "Follow README → Update recovery. Check disk space and .data/application/update.log before restarting." };
  }
}

function command(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, timeout: 1_800_000, shell: process.platform === "win32" && command === "npm", ...options });
    let output = "";
    const diagnostic = chunk => {
      if (["preparing", "updating"].includes(state.phase)) appendFileSync(join(directory, "update.log"), chunk, { mode: 0o600 });
    };
    child.stdout?.on("data", chunk => { output = (output + chunk).slice(-1_000_000); diagnostic(chunk); });
    child.stderr?.on("data", diagnostic); // Keep diagnostics local; never put command output in web status.
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} ${args.slice(0, 2).join(" ")} failed (${code}).`)));
  });
}
async function dockerReady() {
  try { await command("docker", ["info"], { timeout: 10_000 }); return; } catch { /* Desktop may not have started at sign-in. */ }
  if (process.platform === "win32") {
    const executable = join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe");
    if (!existsSync(executable)) throw new Error("Install Docker Desktop, then start Moneo again.");
    const desktop = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: true });
    desktop.on("error", error => log(error.message)); desktop.unref();
  } else if (process.platform === "darwin") await command("open", ["-a", "Docker"]);
  else {
    // Docker Engine installations normally run as a system service; Desktop has a user service.
    await command("systemctl", ["--user", "start", "docker-desktop"]).catch(() => {});
  }
  for (let attempt = 0; attempt < 90; attempt++) {
    await sleep(2000);
    try { await command("docker", ["info"], { timeout: 10_000 }); return; } catch { /* Wait for the engine. */ }
  }
  throw new Error("Docker did not become ready. Start Docker and run npm start again.");
}
const busy = () => new Promise(resolve => {
  const socket = createConnection(port, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});
function openBrowser(target) {
  const executable = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", target] : [target];
  const browser = spawn(executable, args, { stdio: "ignore", detached: true, windowsHide: true });
  browser.on("error", error => log(`Could not open browser: ${error.message}`)); browser.unref();
}
async function startWebsite() {
  if (await busy()) throw new Error(`Port ${port} is already in use. Moneo will not stop another process.`);
  if (!existsSync(join(root, ".next", "BUILD_ID"))) throw new Error("Build Moneo first with npm run build.");
  const output = openSync(join(directory, "website.log"), "a", 0o600);
  child = spawn(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ["ignore", output, output],
  });
  closeSync(output);
  let failed = false;
  child.on("error", () => { failed = true; });
  child.on("exit", () => {
    failed = true;
    if (!stopping && state.phase === "ready") state = { phase: "failed", message: "Moneo stopped. Check .data/application/website.log and restart with npm start." };
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (failed) throw new Error("Moneo could not start. Check .data/application/website.log.");
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { state = { phase: "ready", message: "Moneo is ready." }; return; }
    } catch { /* Wait for Next.js. */ }
    await sleep(1000);
  }
  await stopWebsite();
  throw new Error("Moneo did not become ready. Check .data/application/website.log.");
}
async function stopWebsite() {
  if (!child?.pid || child.exitCode !== null) return;
  const owned = child;
  await new Promise(resolve => {
    const timer = setTimeout(() => owned.kill("SIGKILL"), 15_000);
    owned.once("exit", () => { clearTimeout(timer); resolve(); });
    owned.kill("SIGTERM");
  });
}

// A stale file never authorizes stopping a PID; only the child this launcher spawned is stopped.
try {
  const lock = openSync(lockPath, "wx", 0o600); closeSync(lock);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  try {
    const status = await launcherRequest(root);
    const runtime = readJson(runtimePath);
    if (status.phase === "failed") await launcherRequest(root, process.argv.includes("--resume") ? "/resume" : "/retry", {});
    if (!login || preferences(root).openBrowser) openBrowser(["ready", "restored"].includes(status.phase) ? url : `http://127.0.0.1:${runtime.port}/#${runtime.token}`);
    process.exit(0);
  } catch {
    const previous = readJson(runtimePath);
    if (previous?.pid) {
      try { process.kill(previous.pid, 0); throw new Error("A launcher may still be running. Check its log before removing .data/application/launcher.lock."); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    } else throw new Error("A launcher is starting or was interrupted. If none is running, remove .data/application/launcher.lock and try again.");
    rmSync(lockPath);
    const lock = openSync(lockPath, "wx", 0o600); closeSync(lock);
  }
}

const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? "")) { response.writeHead(403).end(); return; }
  if (request.method === "GET" && request.url === "/") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(progressPage(url)); return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET" && request.url === "/status") { response.end(JSON.stringify(state)); return; }
  if (request.method === "POST" && ["/retry", "/resume"].includes(request.url)) {
    if (state.phase !== "failed") { response.writeHead(409).end(JSON.stringify({ error: "Moneo is already running or starting." })); return; }
    state = { phase: "starting", message: "Starting Moneo…" };
    response.end(JSON.stringify({ ok: true }));
    void launch(request.url === "/resume");
    return;
  }
  if (request.method === "POST" && request.url === "/begin") {
    if (state.phase === "queued" && pendingUpdate) {
      const input = pendingUpdate; pendingUpdate = null;
      state = { phase: "preparing", message: "Checking the release before stopping Moneo…" };
      response.end(JSON.stringify({ ok: true }));
      void performUpdate(input);
    } else response.end(JSON.stringify({ ok: false }));
    return;
  }
  if (request.method === "POST" && request.url === "/update") {
    let body = "";
    try {
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024) throw new Error("Update request is too large.");
      }
      const input = parseUpdateTarget(JSON.parse(body));
      if (!["ready", "restored", "queued"].includes(state.phase)) { response.writeHead(409).end(JSON.stringify({ error: "Moneo is starting, updating, or needs recovery." })); return; }
      pendingUpdate = input;
      state = { phase: "queued", message: "Opening update progress…" };
      response.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/#${token}` }));
    } catch { response.writeHead(400).end(JSON.stringify({ error: "Invalid update request." })); }
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: "Unknown request." }));
});
async function launch(resume = false) {
  try {
    const interrupted = readJson(join(directory, "update-status.json"));
    if (interrupted && ["updating", "failed"].includes(interrupted.phase) && !resume) {
      state = { phase: "failed", message: "The previous update needs recovery before Moneo can start.", recovery: interrupted.recovery || "Follow README → Update recovery. After repairing the installation, run npm start -- --resume." };
      console.error(state.message);
      openBrowser(`http://127.0.0.1:${server.address().port}/#${token}`);
      return;
    }
    await stopWebsite();
    await dockerReady();
    await command("docker", ["compose", "up", "--detach", "--wait"]);
    await startWebsite();
    if (resume) writeJson(join(directory, "update-status.json"), state);
    if (login && preferences(root).openBrowser) openBrowser(url);
    console.log(`Moneo is running at ${url}`);
    if (preferences(root).checkUpdates) void checkRelease(root);
  } catch (error) {
    state = { phase: "failed", message: error.message };
    log(error.message); console.error(error.message);
    if (login) openBrowser(`http://127.0.0.1:${server.address().port}/#${token}`);
  }
}
server.listen(0, "127.0.0.1", () => {
  writeJson(runtimePath, { pid: process.pid, port: server.address().port, token });
  void launch(process.argv.includes("--resume"));
});
const releaseTimer = setInterval(() => {
  if (preferences(root).checkUpdates && ["ready", "restored"].includes(state.phase)) void checkRelease(root);
}, 3_600_000);
releaseTimer.unref();
async function shutdown() {
  if (stopping) return;
  stopping = true; await stopWebsite();
  server.close(); rmSync(runtimePath, { force: true }); rmSync(lockPath, { force: true }); process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);

function progressPage(target) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moneo application</title><style>body{font:16px system-ui;max-width:42rem;margin:12vh auto;padding:24px;background:#111827;color:#f3f4f6}p{line-height:1.6}a{color:#93c5fd}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Moneo</h1><p id="status" role="status">Connecting to the launcher…</p><pre id="detail"></pre><a href="${target}">Open Moneo</a><script>const token=location.hash.slice(1)||sessionStorage.getItem('launcher-token');sessionStorage.setItem('launcher-token',token||'');history.replaceState(null,'','/');const headers={authorization:'Bearer '+token};async function poll(){try{const response=await fetch('/status',{headers});if(!response.ok)throw Error();const state=await response.json();document.getElementById('status').textContent=state.message;document.getElementById('detail').textContent=state.recovery||'';if(state.phase==='ready'){location.replace(${JSON.stringify(target + "/settings#application")});return}}catch{document.getElementById('status').textContent='The launcher is unavailable. Check its local log and run npm start again.'}setTimeout(poll,1500)}fetch('/begin',{method:'POST',headers}).catch(()=>{}).finally(poll)</script></html>`;
}
