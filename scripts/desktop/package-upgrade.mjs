// Install, upgrade and uninstall the Windows installer, keeping the owner's data, in temporary folders,
// then update 0.1.0 to 0.1.1 from Settings (from a local feed, as from GitHub releases):
//   node scripts/desktop/package-upgrade.mjs [--build]
// --build makes two test installers from the current desktop/.build (0.1.0 and 0.1.1, version set at
// build time, no Start menu or desktop shortcuts). The installs go to a temporary folder (/D=), never
// the default per-user location, and Moneo's home is a temporary MONEO_DESKTOP_HOME.
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { alive, check, Desktop, importCsv, powershell, root, statement, summary, tempHome, transactionsText, until } from "./harness.mjs";

if (process.platform !== "win32") { console.error("The installer check is for Windows (NSIS)."); process.exit(1); }
const installers = path.join(os.tmpdir(), "moneo-shell-qa-isolated-installers");
const installer = version => path.join(installers, version, `Moneo-Setup-${version}-x64.exe`);
const defaultInstall = path.join(process.env.LOCALAPPDATA, "Programs", "moneo-desktop");

if (process.argv.includes("--build")) {
  for (const version of ["0.1.0", "0.1.1"]) {
    const env = { ...process.env, MONEO_DESKTOP_VERSION: version, MONEO_DESKTOP_RELEASE_DIR: path.join(installers, version), MONEO_DESKTOP_TEST_INSTALLER: "1" };
    const result = spawnSync(process.execPath, [path.join(root, "node_modules", "electron-builder", "cli.js"), "--projectDir", "desktop", "--config", "electron-builder.config.cjs", "--win", "nsis"], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
    if (result.status !== 0) { console.error(`building ${version} failed`); process.exit(1); }
  }
}
for (const version of ["0.1.0", "0.1.1"]) if (!existsSync(installer(version))) { console.error(`Missing ${installer(version)}; run with --build.`); process.exit(1); }

const defaultBefore = existsSync(defaultInstall);
const installDir = tempHome("install");
rmSync(installDir, { recursive: true, force: true }); // the installer creates it
const exe = path.join(installDir, "Moneo-QA.exe");
const app = new Desktop(exe, "upgrade");
const backups = () => existsSync(path.join(app.home, "backups")) ? readdirSync(path.join(app.home, "backups")) : [];
// Installers inherit this environment, so anything they start uses the temporary home too.
const run = (file, args) => new Promise(resolve => spawn(file, args, { env: app.env, stdio: "ignore" }).on("exit", resolve));
const installedByUs = (dir = installDir) => {
  const entries = powershell("Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Moneo*' } | Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString | ConvertTo-Json -Compress");
  return (entries ? [].concat(JSON.parse(entries)) : []).filter(entry => ((entry.InstallLocation ?? "").toLowerCase().startsWith(dir.toLowerCase()) || (entry.UninstallString ?? "").toLowerCase().startsWith(`"${dir.toLowerCase()}\\`)));
};

try {
  check("installs into the temporary folder", await run(installer("0.1.0"), ["/S", `/D=${installDir}`]) === 0 && existsSync(exe), installDir);
  check("the default per-user location is untouched", existsSync(defaultInstall) === defaultBefore, defaultInstall);
  check("registered as 0.1.0 at the temporary folder", installedByUs()[0]?.DisplayVersion === "0.1.0");

  await app.launch();
  const setup = await app.setupPage();
  const firstVersion = await until("the version on the setup window", async () => (await setup.locator("#version").innerText()) || null, 30_000).catch(() => "");
  let page = await app.appPage();
  await importCsv(page, { filename: "before-upgrade.csv", accountName: "Upgrade checking", csv: statement([["2026-10-01", "Before upgrade rent", "-900.00"]]) });
  check("0.1.0 runs and shows its version", firstVersion === "Moneo 0.1.0" && /Moneo 0\.1\.0 starting/.test(app.log()), firstVersion);
  const beforeUpgrade = backups();
  app.snapshot();

  // Upgrade while Moneo runs: the installer asks it to quit, then replaces the files.
  await app.cdp?.close().catch(() => {});
  app.cdp = undefined;
  check("0.1.1 installs over 0.1.0", await run(installer("0.1.1"), ["/S", `/D=${installDir}`]) === 0);
  await until("0.1.0 to exit", async () => app.child.exited, 60_000).catch(() => {});
  check("the installer quits the running Moneo cleanly", app.child.exited && /Quitting[\s\S]*Stopped/.test(app.log()) && [...app.seen.values()].every(row => !alive(row.pid)));
  check("registered as 0.1.1", installedByUs()[0]?.DisplayVersion === "0.1.1");

  await app.launch();
  const upgraded = await app.setupPage();
  const secondVersion = await until("the version on the setup window", async () => (await upgraded.locator("#version").innerText()) || null, 30_000).catch(() => "");
  page = await app.appPage(240_000);
  check("0.1.1 starts and shows its version", secondVersion === "Moneo 0.1.1" && /Moneo 0\.1\.1 starting/.test(app.log()), secondVersion);
  check("data from 0.1.0 is kept", (await transactionsText(page)).includes("Before upgrade rent"));
  const config = JSON.parse(readFileSync(path.join(app.home, "config.json"), "utf8"));
  check("the backend records the new app version", config.appVersion === "0.1.1", config.appVersion);
  const preUpgrade = backups().filter(name => !beforeUpgrade.includes(name) && name.includes("pre-upgrade"));
  check("no pre-upgrade backup when no migrations were pending", preUpgrade.length === 0, preUpgrade.join(", ") || "none");
  app.snapshot();
  await app.quit();

  // Uninstall: the app goes, the owner's data stays.
  const uninstaller = path.join(installDir, "Uninstall Moneo-QA.exe");
  await run(uninstaller, ["/S"]);
  await until("the uninstall", async () => !existsSync(exe) && installedByUs().length === 0, 60_000).catch(() => {});
  check("uninstall removes the app", !existsSync(exe) && installedByUs().length === 0);
  check("uninstall keeps Moneo's data", existsSync(path.join(app.home, "config.json")) && existsSync(path.join(app.home, "postgres", "PG_VERSION")) && backups().length > 0);
  check("the default per-user location is still untouched", existsSync(defaultInstall) === defaultBefore);
} catch (error) {
  check("upgrade run", false, error.message);
} finally {
  await app.cleanup();
  if (existsSync(path.join(installDir, "Uninstall Moneo-QA.exe"))) await run(path.join(installDir, "Uninstall Moneo-QA.exe"), ["/S"]);
  rmSync(installDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

// Update from Settings: the feed serves 0.1.1's installer and latest.yml, as a GitHub release does.
const feed = http.createServer((req, res) => {
  const file = path.join(installers, "0.1.1", path.basename(decodeURIComponent(new URL(req.url, "http://feed").pathname)));
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200);
  createReadStream(file).pipe(res);
});
await new Promise(resolve => feed.listen(0, "127.0.0.1", resolve));
const updateDir = tempHome("update-install");
rmSync(updateDir, { recursive: true, force: true });
// After installing, Windows starts the update without this environment, so it opens the test build's
// default home: use that one throughout (never the owner's; see electron-builder.config.cjs).
const qaHome = path.join(process.env.APPDATA, "Moneo QA");
rmSync(qaHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
const updating = new Desktop(path.join(updateDir, "Moneo-QA.exe"), "update", { MONEO_DESKTOP_HOME: qaHome, MONEO_DESKTOP_UPDATE_FEED: `http://127.0.0.1:${feed.address().port}/` });
rmSync(updating.home, { recursive: true, force: true });
updating.home = qaHome;
const runIn = (file, args) => new Promise(resolve => spawn(file, args, { env: updating.env, stdio: "ignore" }).on("exit", resolve));
try {
  check("update: 0.1.0 installs", await runIn(installer("0.1.0"), ["/S", `/D=${updateDir}`]) === 0 && installedByUs(updateDir)[0]?.DisplayVersion === "0.1.0");
  await updating.launch();
  let page = await updating.appPage();
  await importCsv(page, { filename: "before-update.csv", accountName: "Update checking", csv: statement([["2026-10-02", "Before update groceries", "-42.00"]]) });
  await page.goto(`${new URL(page.url()).origin}/settings#updates`);
  const updates = page.locator("#updates");
  await updates.getByRole("button", { name: "Check for updates" }).click();
  await updates.getByText("Moneo 0.1.1 is available").waitFor({ timeout: 60_000 });
  check("update: Settings finds 0.1.1", true);
  updating.snapshot();
  await updates.getByRole("button", { name: "Update to 0.1.1" }).click();
  await updating.cdp?.close().catch(() => {});
  updating.cdp = undefined;
  await until("0.1.0 to quit for the update", async () => updating.child.exited, 180_000).catch(() => {});
  check("update: Moneo quits cleanly to install it", updating.child.exited && /Installing Moneo 0\.1\.1[\s\S]*Quitting[\s\S]*Stopped/.test(updating.log()));
  const restarted = await until("0.1.1 to start by itself", async () => /Moneo 0\.1\.1 starting[\s\S]*Next server is ready/.test(updating.log()), 300_000).catch(() => false);
  check("update: 0.1.1 is installed and starts by itself", restarted && installedByUs(updateDir)[0]?.DisplayVersion === "0.1.1");
  // The restarted Moneo has no DevTools port: quit it (same home, so same instance), then open it again.
  await updating.second(["--quit"]);
  await until("the updated Moneo to quit", async () => /Moneo 0\.1\.1 starting[\s\S]*Stopped/.test(updating.log()), 60_000).catch(() => {});
  await updating.launch();
  page = await updating.appPage();
  check("update: data from 0.1.0 is kept", (await transactionsText(page)).includes("Before update groceries"));
  await updating.quit();
} catch (error) {
  check("update run", false, error.message);
} finally {
  if (!updating.child?.exited) await updating.second(["--quit"]).catch(() => {});
  await updating.cleanup();
  if (existsSync(path.join(updateDir, "Uninstall Moneo-QA.exe"))) await runIn(path.join(updateDir, "Uninstall Moneo-QA.exe"), ["/S"]);
  rmSync(updateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  feed.close();
}

process.exit(summary() ? 1 : 0);
