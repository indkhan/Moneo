// End-to-end checks of the PACKAGED desktop app (after npm run desktop:dist), in temporary homes.
//   node scripts/desktop/package-smoke.mjs [path to the executable]
// Playwright drives the app over the Chrome DevTools protocol (--remote-debugging-port, which the
// packaged app accepts only with MONEO_DESKTOP_DEBUG=1): its --inspect fuse is off, which
// Playwright's _electron.launch needs. MONEO_DESKTOP_DEBUG=1 also enables the --debug-action hooks
// that stand in for tray clicks. Window-message steps run on Windows only.
import { spawn } from "node:child_process";
import postgres from "postgres";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { alive, check, defaultExe, Desktop, importCsv, listeningPid, processesOf, statement, summary, tempHome, transactionsText, until } from "./harness.mjs";

const exe = path.resolve(process.argv[2] ?? defaultExe());
if (!existsSync(exe)) { console.error(`No packaged app at ${exe}. Run npm run desktop:build && npm run desktop:dist first.`); process.exit(1); }
const windows = process.platform === "win32";

const fuses = await getCurrentFuseWire(exe);
const off = option => fuses[option] === FuseState.DISABLE, on = option => fuses[option] === FuseState.ENABLE;
check("fuses: RunAsNode, NODE_OPTIONS and --inspect off; cookie encryption, asar-only and asar integrity on",
  off(FuseV1Options.RunAsNode) && off(FuseV1Options.EnableNodeOptionsEnvironmentVariable) && off(FuseV1Options.EnableNodeCliInspectArguments)
  && on(FuseV1Options.EnableCookieEncryption) && on(FuseV1Options.OnlyLoadAppFromAsar) && (process.platform === "linux" || on(FuseV1Options.EnableEmbeddedAsarIntegrityValidation)));

// Without MONEO_DESKTOP_DEBUG the packaged app refuses debugging switches before doing anything.
for (const flag of ["--remote-debugging-port=0", "--remote-debugging-pipe", "--inspect"]) {
  const home = tempHome("refuse");
  const env = { ...process.env, MONEO_DESKTOP_HOME: home };
  delete env.MONEO_DESKTOP_DEBUG;
  const child = spawn(exe, [flag], { env, stdio: "ignore" });
  const code = await Promise.race([new Promise(resolve => child.on("exit", resolve)), new Promise(resolve => setTimeout(() => resolve("running"), 15_000))]);
  if (code === "running") {
    // Not refused: stop it the normal way, then anything it left in that home.
    const started = processesOf(child.pid, home);
    await new Promise(resolve => spawn(exe, ["--quit"], { env, stdio: "ignore" }).on("exit", resolve));
    await until("the unrefused app to exit", async () => !alive(child.pid), 60_000).catch(() => {});
    for (const row of [...started, ...processesOf(child.pid, home)]) if (alive(row.pid)) try { process.kill(row.pid); } catch { /* gone */ }
  }
  const log = existsSync(path.join(home, "logs", "main.log")) ? readFileSync(path.join(home, "logs", "main.log"), "utf8") : "";
  check(`refuses ${flag.split("=")[0]} without MONEO_DESKTOP_DEBUG`, code === 1 && /Refusing to start/.test(log) && !existsSync(path.join(home, "config.json")), `exit ${code}`);
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

const app = new Desktop(exe, "smoke");
const backups = () => existsSync(path.join(app.home, "backups")) ? readdirSync(path.join(app.home, "backups")) : [];
const newBackup = (before, reason) => until(`a ${reason} backup`, async () => backups().find(name => !before.includes(name) && name.includes(reason) && !name.endsWith(".partial")), 60_000);
const health = port => fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: "Bearer smoke" } }).then(response => response.ok, () => false);

const guardrailDb = user => {
  const config = JSON.parse(readFileSync(path.join(app.home, "config.json"), "utf8"));
  return postgres({ host: "127.0.0.1", port: config.ports.db, database: "postgres", username: user,
    password: config.secrets.POSTGRES_PASSWORD, max: 1 });
};
async function checkWriteGuard(label) {
  const db = guardrailDb("authenticator");
  try {
    await db`CREATE TEMP TABLE desktop_guardrail (id integer)`;
    await db`INSERT INTO desktop_guardrail VALUES (1)`;
    const blocked = async query => {
      try { await query; return false; } catch (error) { if (error.code !== "21000") throw error; return true; }
    };
    const updateBlocked = await blocked(db`UPDATE desktop_guardrail SET id = 2`);
    const deleteBlocked = await blocked(db`DELETE FROM desktop_guardrail`);
    await db`UPDATE desktop_guardrail SET id = 2 WHERE id = 1`;
    const rows = await db`DELETE FROM desktop_guardrail WHERE id = 2 RETURNING id`;
    check(label, updateBlocked && deleteBlocked && rows.length === 1);
  } finally { await db.end(); }
}

try {
  // First run, Home, navigation rules.
  await app.launch();
  const setup = await app.setupPage();
  check("setup window appears", true, await setup.locator("#title").innerText());
  let page = await app.appPage();
  await page.waitForLoadState("load");
  const port = Number(new URL(page.url()).port);
  check("app window loads Home", new URL(page.url()).pathname === "/" && !/could not sign you in/i.test(await page.locator("body").innerText()), page.url());
  check("setup window closes after start", !(await app.urls()).some(url => url.endsWith("/setup/index.html")));

  await checkWriteGuard("fresh backend blocks unfiltered writes and allows filtered writes");
  const external = "https://example.com/moneo-desktop-smoke";
  await page.evaluate(url => { window.location.assign(url); }, external);
  await until("the external link in the log", async () => app.external().includes(external), 10_000);
  check("external navigation goes to the system browser, not the window", new URL(page.url()).hostname === "localhost");
  const popup = "https://example.org/moneo-desktop-popup";
  await page.evaluate(url => { window.open(url, "_blank"); }, popup);
  await until("the popup in the log", async () => app.external().includes(popup), 10_000);
  check("window.open goes to the system browser", !(await app.urls()).some(url => url.includes("example.org")));

  // Voice calls: the microphone is granted for Moneo's page (a fake device stands in for a real one).
  const mic = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => { stream.getTracks().forEach(track => track.stop()); return "granted"; }, error => error.name));
  check("microphone is granted for Moneo's own page", mic === "granted", mic);

  // Tray: Back up now, Open in browser (the hooks call the tray menu's own actions).
  const before = backups();
  await app.second(["--debug-action=backUp"]);
  check("tray Back up now writes a backup", await newBackup(before, "manual").catch(() => false));
  await app.second(["--debug-action=openInBrowser"]);
  await until("Open in browser in the log", async () => app.external().includes(`http://localhost:${port}/`), 10_000).catch(() => {});
  check("tray Open in browser goes to the system browser", app.external().includes(`http://localhost:${port}/`));

  // Close hides to the tray; a second launch brings the window back.
  if (windows) {
    const handle = app.mainWindow();
    app.closeWindow(handle);
    await until("the window to hide", async () => !app.windowVisible(handle), 10_000);
    check("closing the window hides it and the server keeps answering", !app.child.exited && await health(port));
    await app.second([]);
    check("launching Moneo again shows the hidden window", await until("the window to show", async () => app.windowVisible(handle), 10_000).catch(() => false));
  }

  // Crash: the server is restarted.
  const serverPid = listeningPid(port);
  process.kill(serverPid);
  await until("the server to go down", async () => !alive(serverPid), 10_000);
  const restartedPid = await until("the server to come back", async () => await health(port) && listeningPid(port), 90_000).catch(() => null);
  await page.reload();
  check("a crashed server is restarted", restartedPid && restartedPid !== serverPid && /Restarting the Next server/.test(app.log()), `pid ${serverPid} → ${restartedPid}`);

  // Restore: data from before the backup comes back, data written after it is gone.
  await importCsv(page, { filename: "before-backup.csv", accountName: "Smoke checking", csv: statement([["2026-09-01", "Before backup coffee", "-3.20"]]) });
  const manualBackups = () => app.log().split(/\r?\n/).filter(line => line.includes("Backup (manual) written to")).map(line => line.split("written to ")[1].trim());
  const written = manualBackups().length;
  await app.second(["--debug-action=backUp"]);
  const folder = await until("the manual backup", async () => manualBackups()[written], 60_000);
  await importCsv(page, { filename: "after-backup.csv", accountName: "Smoke checking", csv: statement([["2026-09-02", "After backup tea", "-2.10"]]) });
  const beforeRestore = backups();
  await app.second([`--debug-action=restore=${folder}`]);
  await until("the restore", async () => app.log().includes(`Restored from ${folder}`), 180_000);
  page = await app.appPage();
  await until("the server after the restore", async () => health(port), 120_000);
  const restored = await transactionsText(page);
  check("restore brings back data from before the backup and drops later data", restored.includes("Before backup coffee") && !restored.includes("After backup tea"));
  check("restore keeps a backup of the replaced data", backups().some(name => !beforeRestore.includes(name) && name.includes("before-restore")));

  // Simulate a home created before safeupdate was bundled.
  const admin = guardrailDb("supabase_admin");
  try { await admin.unsafe("ALTER ROLE authenticator RESET session_preload_libraries"); }
  finally { await admin.end(); }

  // Quit, then start again in the same home: the data is kept.
  app.snapshot();
  await app.quit();
  const left = [...app.seen.values()].filter(row => alive(row.pid));
  check("quit stops every process", left.length === 0, left.map(row => `${row.name}#${row.pid}`).join(", "));
  check("the server port is closed after quit", !(await health(port)));
  await app.launch();
  page = await app.appPage(120_000);
  check("relaunching in the same home keeps the data", (await transactionsText(page)).includes("Before backup coffee"));
  check("the app keeps its port", Number(new URL(page.url()).port) === port);
  await checkWriteGuard("existing backend restores the unfiltered-write guard on startup");

  // A database that cannot start: the error screen, then Retry.
  app.snapshot();
  await app.quit();
  const versionFile = path.join(app.home, "postgres", "PG_VERSION");
  const original = readFileSync(versionFile, "utf8");
  writeFileSync(versionFile, "99\n");
  await app.launch();
  const failed = await app.setupPage();
  await until("the error screen", async () => !(await failed.locator("#failure").isHidden()), 120_000);
  check("a database that cannot start shows the error screen", /could not start/i.test(await failed.locator("#title").innerText()), (await failed.locator("#error-summary").innerText()).slice(0, 160));
  const setupMic = await failed.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "granted", error => error.name));
  check("microphone is denied outside Moneo's pages (the local status window)", setupMic === "NotAllowedError", setupMic);
  writeFileSync(versionFile, original);
  await failed.locator("#retry").click();
  page = await app.appPage(180_000);
  check("Retry starts Moneo once the problem is fixed", (await transactionsText(page)).includes("Before backup coffee"));

  app.snapshot();
  await app.quit();
  const leftAll = [...app.seen.values()].filter(row => alive(row.pid));
  check("no process from any launch is left", leftAll.length === 0, leftAll.map(row => `${row.name}#${row.pid}`).join(", "));
} catch (error) {
  check("smoke run", false, error.message);
} finally {
  await app.cleanup();
}

process.exit(summary() ? 1 : 0);
