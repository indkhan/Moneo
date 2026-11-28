import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

if (!existsSync(".env.qa")) throw new Error("No .env.qa: run `npm run setup -- --qa` first.");
const qa = parseEnv(readFileSync(".env.qa", "utf8"));
const names = file => existsSync(file) ? [...readFileSync(file, "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]) : [];
const blank = Object.fromEntries([...names(".env.example"), ...names(".env")].map(name => [name, ""]));
const port = process.env.QA_PORT ?? "3100";
if (!/^\d+$/.test(port) || port === "3000") throw new Error("QA_PORT must be a free port other than 3000, which is the owner's app (AGENTS.md Test backend).");
const paid = process.env.E2E_REAL_AI === "1" ? {} : { OPENAI_API_KEY: "sk-qa-placeholder-not-a-real-key", OPENROUTER_API_KEY: "" };
const mockAi = process.argv.includes("--mock-ai");
if (mockAi && process.env.E2E_REAL_AI === "1") throw new Error("--mock-ai cannot be combined with E2E_REAL_AI=1.");
const env = {
  ...process.env, ...blank, ...qa, ...paid,
  ENABLE_BANKING_APP_ID: "", ENABLE_BANKING_PRIVATE_KEY: "",
  MONEO_QA_MOCK_AI: mockAi ? "1" : "",
  PORT: port, NEXT_PUBLIC_APP_URL: `http://localhost:${port}`, WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}`, NEXT_DIST_DIR: ".next-qa",
};
const next = "node_modules/next/dist/bin/next";
const production = process.argv.includes("--production");
if (production) execFileSync(process.execPath, [next, "build"], { env, stdio: "inherit" });
const server = spawn(process.execPath, [next, production ? "start" : "dev", "-H", "127.0.0.1", "-p", port], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", code => process.exit(code ?? 0));
