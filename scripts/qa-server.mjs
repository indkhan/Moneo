// Runs this checkout's app for tests on http://localhost:3100, against the moneo-qa backend in
// .env.qa (npm run setup -- --qa). Bank access is off and the AI key is a placeholder that every
// provider rejects, so nothing costs money; scheduled jobs only see the test backend. It builds into
// .next-qa, so it can run beside the owner's app. Playwright starts it on its own.
//   npm run qa:server                  (dev server)
//   npm run qa:server -- --production  (build, then start)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

if (!existsSync(".env.qa")) throw new Error("No .env.qa: run `npm run setup -- --qa` first.");
const qa = parseEnv(readFileSync(".env.qa", "utf8"));
// Next also reads .env; an empty value here keeps every owner setting from leaking in.
const names = file => existsSync(file) ? [...readFileSync(file, "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]) : [];
const blank = Object.fromEntries([...names(".env.example"), ...names(".env")].map(name => [name, ""]));
// The app treats AI as set up, but a real call fails. Specs that call the real model (E2E_REAL_AI=1)
// take the key from .env.qa instead.
const paid = process.env.E2E_REAL_AI === "1" ? {} : { OPENAI_API_KEY: "sk-qa-placeholder-not-a-real-key", OPENROUTER_API_KEY: "" };
const env = {
  ...process.env, ...blank, ...qa, ...paid,
  ENABLE_BANKING_APP_ID: "", ENABLE_BANKING_PRIVATE_KEY: "",
  PORT: "3100", NEXT_PUBLIC_APP_URL: "http://localhost:3100", WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:3100", NEXT_DIST_DIR: ".next-qa",
};
const next = "node_modules/next/dist/bin/next";
const production = process.argv.includes("--production");
if (production) execFileSync(process.execPath, [next, "build"], { env, stdio: "inherit" });
const server = spawn(process.execPath, [next, production ? "start" : "dev", "-H", "127.0.0.1", "-p", "3100"], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", code => process.exit(code ?? 0));
