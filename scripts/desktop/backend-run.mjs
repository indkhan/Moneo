// Runs the native desktop backend under plain Node until stopped, for development and checks:
//   node scripts/desktop/backend-run.mjs --home <dir> [--resources <dir>]   (resources: desktop/.build)
// Writes the app environment to <home>/run/env.json (it holds secrets; the home is yours alone).
// Stops cleanly on Ctrl+C, or when <home>/run/stop exists (for runs started in the background).
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { built, loadBackend } from "./backend-load.mjs";

const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
if (!option("--home")) throw new Error("Usage: node scripts/desktop/backend-run.mjs --home <dir> [--resources <dir>]");
const home = path.resolve(option("--home"));
const resources = path.resolve(option("--resources") ?? built);
await fs.mkdir(path.join(home, "run"), { recursive: true });
const backend = await loadBackend(path.join(home, "run"));
const running = await backend.startBackend({ resources, home }, step => console.log(`[${step.state}] ${step.label}${step.detail ? `: ${step.detail}` : ""}`));
running.onExit((service, code) => console.error(`${service} exited unexpectedly (${code})`));
const stopFile = path.join(home, "run", "stop");
await fs.rm(stopFile, { force: true });
await fs.writeFile(path.join(home, "run", "env.json"), JSON.stringify(running.env, null, 2), { mode: 0o600 });
console.log(`Backend running at ${running.env.NEXT_PUBLIC_SUPABASE_URL}; env in ${path.join(home, "run", "env.json")}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(poll);
  await running.stop();
  await fs.rm(stopFile, { force: true });
  console.log("Backend stopped");
};
const poll = setInterval(() => { if (existsSync(stopFile)) stop(); }, 1000);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
