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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
if (process.env.NEXT_DIST_DIR || process.env.PORT === "3100") throw new Error("Use npm run qa:server for the test backend.");
// Login agents have a smaller PATH than interactive terminals, especially on macOS.
process.env.PATH = [dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", join(homedir(), ".docker", "bin"), ...(process.platform === "win32" ? [join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "resources", "bin")] : []), process.env.PATH || ""].join(delimiter);
const directory = applicationDirectory(root);
mkdirSync(directory, { recursive: true });
const log = message => appendFileSync(join(directory, "launcher.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid application port.");
const url = `http://localhost:${port}`;
const login = process.argv.includes("--login");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let stopping = false;
let state = { phase: "starting", message: "Starting Moneo…" };
const token = randomBytes(32).toString("hex");
const runtimePath = join(directory, "runtime.json");
const lockPath = join(directory, "launcher.lock");

function command(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { cwd: root, windowsHide: true, timeout: 300_000, ...options });
    let output = "";
    process.stdout?.on("data", chunk => { output += chunk; });
    process.stderr?.on("data", () => {}); // Never copy command output containing owner data into the web status.
    process.on("error", reject);
    process.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed (${code}).`)));
  });
}
async function dockerReady() {
  try { await command("docker", ["info"]); return; } catch { /* Desktop may not have started at sign-in. */ }
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
    try { await command("docker", ["info"]); return; } catch { /* Wait for the engine. */ }
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
  if (!child || child.exitCode !== null) return;
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
    await launcherRequest(root);
    if (!login || preferences(root).openBrowser) openBrowser(url);
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
  response.writeHead(404).end(JSON.stringify({ error: "Unknown request." }));
});
server.listen(0, "127.0.0.1", async () => {
  writeJson(runtimePath, { pid: process.pid, port: server.address().port, token });
  try {
    await dockerReady();
    await command("docker", ["compose", "up", "--detach", "--wait"]);
    await startWebsite();
    if (login && preferences(root).openBrowser) openBrowser(url);
    console.log(`Moneo is running at ${url}`);
  } catch (error) {
    state = { phase: "failed", message: error.message };
    log(error.message); console.error(error.message);
    if (login) openBrowser(`http://127.0.0.1:${server.address().port}/#${token}`);
  }
});
async function shutdown() {
  if (stopping) return;
  stopping = true; await stopWebsite();
  server.close(); rmSync(runtimePath, { force: true }); rmSync(lockPath, { force: true }); process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);

function progressPage(target) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moneo application</title><style>body{font:16px system-ui;max-width:42rem;margin:12vh auto;padding:24px;background:#111827;color:#f3f4f6}p{line-height:1.6}a{color:#93c5fd}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Moneo</h1><p id="status" role="status">Connecting to the launcher…</p><pre id="detail"></pre><a href="${target}">Open Moneo</a><script>const token=location.hash.slice(1);history.replaceState(null,'','/');async function poll(){try{const response=await fetch('/status',{headers:{authorization:'Bearer '+token}});if(!response.ok)throw Error();const state=await response.json();document.getElementById('status').textContent=state.message;document.getElementById('detail').textContent=state.recovery||'';if(state.phase==='ready'){location.replace(${JSON.stringify(target + "/settings#application")});return}}catch{document.getElementById('status').textContent='The launcher is unavailable. Check its local log and run npm start again.'}setTimeout(poll,1500)}poll()</script></html>`;
}
