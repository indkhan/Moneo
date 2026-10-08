// Logs/reports can contain identifying application evidence: keep them ignored.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertRequiredResults } from "./acceptance-results.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");
const tier = process.argv[2];
if (!["fast", "required"].includes(tier)) throw new Error("Use acceptance.mjs fast|required");
const directory = resolve(`.qa/acceptance-${tier}-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const worktreeDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
const migrationHead = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort().at(-1);
const result = { revision, worktreeDirty, migrationHead, tier, environment: "local configured Supabase (not deployed acceptance)", startedAt: new Date().toISOString(), provider: "optional; not run; core-journey.gated.spec.ts excluded because it invokes the live provider; deterministic mocks are not provider evaluation", checks: [] };

function run(name, script, args = [], env = {}) {
  const log = openSync(`${directory}/${name}.log`, "w");
  let child;
  try { child = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", log, log] }); }
  finally { closeSync(log); }
  result.checks.push({ name, passed: child.status === 0 });
  if (child.error || child.status !== 0) throw new Error(`${name} failed; review ignored acceptance logs`);
  console.log(`PASS: ${name}`);
}

try {
  if (tier === "fast") {
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error("Run through npm run acceptance:fast");
    for (const name of ["test", "lint", "build"]) run(name, npm, ["run", name]);
  } else {
    const missing = ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"].filter(name => !process.env[name]);
    const state = process.env.E2E_STORAGE_STATE || "e2e/.auth.json";
    if (!existsSync(state)) missing.push("E2E_STORAGE_STATE (or e2e/.auth.json)");
    if (missing.length) throw new Error(`Required prerequisites missing: ${missing.join(", ")}`);
    run("privacy", "scripts/check-private-data.mjs");
    run("migrations", "supabase/tests/migrations.mjs");
    const units = `${directory}/units.json`, browser = `${directory}/browser.json`;
    // Required tier runs every gated live-DB check; any skip fails the gate below.
    run("units", "node_modules/vitest/vitest.mjs", ["run", "--reporter=json", `--outputFile=${units}`], { RUN_RESERVATION_DB_TESTS: "1", RUN_IMPORT_EXCLUSION_DB_TESTS: "1", RUN_VERIFIED_EVIDENCE_DB_TESTS: "1", RUN_INVESTIGATION_REQUEST_DB_TESTS: "1" });
    const unitReport = JSON.parse(readFileSync(units, "utf8"));
    result.units = { total: unitReport.numTotalTests, failed: unitReport.numFailedTests, skipped: unitReport.numPendingTests };
    assertRequiredResults("vitest", unitReport);
    const specs = readdirSync("e2e").filter(file => file.endsWith(".spec.ts") && file !== "core-journey.gated.spec.ts").map(file => `e2e/${file}`);
    // A fresh local server inherits an empty provider key; never reuse a keyed server.
    run("browser", "node_modules/@playwright/test/cli.js", ["test", ...specs, "--workers=1", "--reporter=json", `--output=${directory}/browser-artifacts`], { PLAYWRIGHT_JSON_OUTPUT_FILE: browser, OPENROUTER_API_KEY: "", CI: "1" });
    const browserReport = JSON.parse(readFileSync(browser, "utf8"));
    result.browser = browserReport.stats;
    assertRequiredResults("playwright", browserReport);
  }
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.failure = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  writeFileSync(`${directory}/result.json`, JSON.stringify(result, null, 2));
  console.log(`Acceptance summary: ${directory}/result.json`);
}
