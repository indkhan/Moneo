// Nightly browser suite on the moneo-qa test backend. It runs every spec twice, so specs that only
// pass on a clean start show up, on a production build of origin/main, in its own worktree
// (~/.moneo/nightly), and keeps one GitHub issue up to date: opened or commented on failure, closed
// when green. A missed night (PC off, Docker off, port 3100 busy) is skipped quietly.
//   npm run qa:nightly                 run now
//   npm run qa:nightly -- --install    schedule it daily at 03:00 (Windows; runs late if the PC was off)
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const home = join(homedir(), ".moneo");
const tree = join(home, "nightly");
const TITLE = "Nightly browser suite is failing";
mkdirSync(home, { recursive: true });
const log = message => { console.log(message); writeFileSync(join(home, "nightly.log"), `${new Date().toISOString()} ${message}\n`, { flag: "a" }); };
// npm and npx are .cmd files on Windows and need a shell; git, gh and docker do not.
const shell = command => process.platform === "win32" && (command === "npm" || command === "npx");
const ok = (command, args) => spawnSync(command, args, { stdio: "ignore", shell: shell(command) }).status === 0;
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit", shell: shell(command) });

if (process.argv.includes("--install")) {
  const repo = resolve(".");
  const runner = join(home, "nightly-e2e.mjs");
  copyFileSync(new URL(import.meta.url), runner);
  if (process.platform !== "win32") {
    console.log(`Add this line with \`crontab -e\` (cron skips missed nights quietly):\n0 3 * * * cd "${repo}" && "${process.execPath}" "${runner}" --repo "${repo}"`);
    process.exit(0);
  }
  const ps = `$a = New-ScheduledTaskAction -Execute '${process.execPath}' -Argument '"${runner}" --repo "${repo}"' -WorkingDirectory '${repo}'
$t = New-ScheduledTaskTrigger -Daily -At 3am
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Moneo nightly browser suite' -Action $a -Trigger $t -Settings $s -Force | Out-Null`;
  execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
  console.log("Scheduled 'Moneo nightly browser suite' daily at 03:00; it runs as soon as possible after a missed start.");
  process.exit(0);
}

const at = process.argv.indexOf("--repo");
const repo = resolve(at > 0 ? process.argv[at + 1] : ".");
const portBusy = () => new Promise(done => { const socket = createConnection(3100, "127.0.0.1"); socket.on("connect", () => { socket.end(); done(true); }); socket.on("error", () => done(false)); });
if (!ok("docker", ["info"])) { log("Skipped: Docker is not running."); process.exit(0); }
if (await portBusy()) { log("Skipped: port 3100 is in use by another QA server."); process.exit(0); }

// Always the latest main, in a worktree nobody edits by hand.
run("git", ["fetch", "--quiet", "origin", "main"], repo);
if (!existsSync(tree)) run("git", ["worktree", "add", "--detach", tree, "origin/main"], repo);
else run("git", ["checkout", "--quiet", "--force", "--detach", "origin/main"], tree);
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: tree, encoding: "utf8" }).trim();
run("npm", ["ci", "--no-audit", "--no-fund"], tree);
run("node", ["scripts/setup.mjs", "--qa"], tree);
run("node", ["scripts/e2e-auth.mjs"], tree);
run("node", ["scripts/e2e-auth.mjs", "--reset"], tree);

const report = join(home, "nightly-report.json");
spawnSync("npx", ["playwright", "test", "--workers=1", "--repeat-each=2", "--reporter=json"], {
  cwd: tree, stdio: ["ignore", "inherit", "inherit"], shell: shell("npx"),
  env: { ...process.env, E2E_PRODUCTION_BUILD: "1", PLAYWRIGHT_JSON_OUTPUT_NAME: report },
});
const failures = [];
const walk = suite => {
  for (const spec of suite.specs ?? []) for (const test of spec.tests) {
    const runs = test.results.map(result => result.status);
    if (runs.some(status => status !== "passed" && status !== "skipped")) failures.push(`- \`${spec.file}\` ${spec.title}: ${runs.join(", ")}`);
  }
  for (const child of suite.suites ?? []) walk(child);
};
const parsed = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;
if (!parsed) failures.push("- The suite did not produce a report (build or server start failed); run `npm run qa:nightly` to see why.");
else for (const suite of parsed.suites) walk(suite);

const open = JSON.parse(execFileSync("gh", ["issue", "list", "--state", "open", "--search", `"${TITLE}" in:title`, "--json", "number"], { cwd: repo, encoding: "utf8" }))[0];
if (failures.length) {
  const body = `Nightly run on \`${sha}\` (each spec twice, production build, moneo-qa):\n\n${[...new Set(failures)].join("\n")}\n\nA spec that passes once and fails the second time depends on state an earlier run left behind.`;
  const bodyFile = join(home, "nightly-issue.md");
  writeFileSync(bodyFile, body);
  if (open) run("gh", ["issue", "comment", String(open.number), "--body-file", bodyFile], repo);
  else run("gh", ["issue", "create", "--title", TITLE, "--body-file", bodyFile], repo);
  log(`Failed on ${sha}: ${failures.length} spec(s).`);
} else {
  if (open) run("gh", ["issue", "close", String(open.number), "--comment", `Green again on \`${sha}\`.`], repo);
  log(`Passed on ${sha}.`);
}
